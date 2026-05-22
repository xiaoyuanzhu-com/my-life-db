//go:build acptest

package acptest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"testing"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
)

// TestACPPromptErrorWedge documents the claude-agent-acp upstream bug where,
// after a prompt errors against the upstream API, the SAME subprocess is left
// in a desynced state: the next prompt returns end_turn with zero content
// frames, and that prompt's actual response leaks out on the prompt AFTER it.
//
// Repro (matches the bug investigated in api/agent_prompt_turn.go):
//
//  1. Open a session with a stubbed Anthropic endpoint that always 400s with
//     invalid_request_error (non-retriable, surfaces immediately).
//  2. Prompt 1 → upstream rejects → events channel emits an AGENT_ERROR frame.
//  3. Prompt 2 on the same subprocess → end_turn with no agent_message_chunk
//     frames (the wedge). No second AGENT_ERROR either.
//
// The workaround in api/agent_prompt_turn.go tears down the subprocess after
// any AGENT_ERROR frame so the next prompt respawns fresh; this test is the
// regression canary that keeps that workaround honest. If the wedge is ever
// fixed upstream, prompt 2 will produce content and this test will fail —
// signalling that the workaround can be deleted.
func TestACPPromptErrorWedge(t *testing.T) {
	if _, err := exec.LookPath("claude-agent-acp"); err != nil {
		t.Skip("claude-agent-acp not found in PATH")
	}

	// Stub Anthropic API that returns 400 invalid_request_error on every
	// request. 4xx auth/rate-limit errors are retried internally by the
	// Anthropic SDK; invalid_request_error is non-retriable and surfaces
	// immediately as a prompt error — which is what we need to wedge the
	// subprocess.
	var hits int
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		t.Logf("[stub] %s %s", r.Method, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"wedge-test stub: forced invalid_request_error"}}`))
	}))
	defer func() {
		t.Logf("[stub] total hits: %d", hits)
		stub.Close()
	}()

	client := agentsdk.NewClient(
		agentsdk.SessionConfig{},
		agentsdk.AgentConfig{
			Type:    agentsdk.AgentClaudeCode,
			Name:    "Claude Code",
			Command: "claude-agent-acp",
			Env: map[string]string{
				"ANTHROPIC_BASE_URL": stub.URL,
				"ANTHROPIC_API_KEY":  "fake-wedge-test-key",
			},
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	session, err := client.CreateSession(ctx, agentsdk.SessionConfig{
		Agent:      agentsdk.AgentClaudeCode,
		Mode:       "bypassPermissions",
		WorkingDir: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	defer session.Close()

	drain := func(label string, events <-chan []byte) (stopReason string, chunks, errs, completes int) {
		for frame := range events {
			var msg map[string]any
			_ = json.Unmarshal(frame, &msg)
			if msg["sessionUpdate"] == "agent_message_chunk" {
				chunks++
			}
			switch msg["type"] {
			case "turn.complete":
				completes++
				if s, ok := msg["stopReason"].(string); ok {
					stopReason = s
				}
			case "error":
				errs++
				t.Logf("[%s] error frame: code=%v message=%v", label, msg["code"], msg["message"])
			}
		}
		t.Logf("[%s] stopReason=%q chunks=%d errors=%d completes=%d", label, stopReason, chunks, errs, completes)
		return
	}

	// --- Prompt 1: upstream 400s → expect an AGENT_ERROR frame ---
	events1, err := session.Send(ctx, "Say hi")
	if err != nil {
		t.Fatalf("Send #1 returned synchronous error: %v", err)
	}
	_, chunks1, errs1, _ := drain("prompt1", events1)
	if errs1 == 0 {
		t.Fatalf("prompt 1: expected at least one error frame from the 400 stub, got %d chunks and 0 errors — stub may not be wired correctly", chunks1)
	}

	// --- Prompt 2: the wedge ---
	// Same subprocess. Expect end_turn with no content and (currently) no
	// new error frame either — the agent's internal state is desynced and
	// the actual response is held back.
	events2, err := session.Send(ctx, "Reply with the single word HELLO")
	if err != nil {
		t.Fatalf("Send #2 returned synchronous error: %v — wedge no longer manifests as observed during the bug investigation", err)
	}
	_, chunks2, errs2, _ := drain("prompt2", events2)

	if chunks2 > 0 {
		t.Errorf("prompt 2 produced %d agent_message_chunks — the upstream wedge may be fixed; if so, consider removing the workaround in api/agent_prompt_turn.go (sawErrorFrame branch)", chunks2)
		return
	}
	if errs2 > 0 {
		t.Logf("PARTIAL WEDGE: prompt 2 produced %d error frame(s) with no content — workaround still applies but the exact symptom differs slightly from the original observation (no error frame on the wedged turn)", errs2)
		return
	}
	t.Logf("WEDGE CONFIRMED: prompt 2 returned end_turn with zero content and zero error frames — matches the original bug, workaround in api/agent_prompt_turn.go is still required")
}
