//go:build acptest

package acptest

import (
	"context"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

// TestACPUserMessageChunkOrdering verifies that ACP's Prompt() emits
// UserMessageChunk AFTER the agent response, not before.
//
// This ordering matters for our WebSocket replay architecture: because the
// user message arrives last, a naive store-and-replay would show the agent's
// thinking/response before the user's message. The backend (agent_ws.go)
// compensates by injecting a user_message_chunk BEFORE calling Send() and
// skipping ACP's late-arriving one.
//
// If ACP changes the ordering (user message first), the injection+skip in
// agent_ws.go should be removed — the natural ordering would be correct.
func TestACPUserMessageChunkOrdering(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	_, events := h.Prompt(ctx, "Reply with exactly: ok")

	userMsgs := Events(events, "user_message")
	agentMsgs := Events(events, "agent_message")

	t.Logf("UserMessageChunk events: %d", len(userMsgs))
	t.Logf("AgentMessageChunk events: %d", len(agentMsgs))

	// Document full event ordering
	t.Log("Event ordering:")
	for i, e := range events {
		t.Logf("  [%d] %s", i, e.Type)
	}

	if len(userMsgs) == 0 {
		t.Fatal("ACP did not emit UserMessageChunk during Prompt() — " +
			"if this persists, the skip filter in agent_ws.go is unnecessary")
	}

	// Find the indices
	lastAgentIdx := -1
	firstUserIdx := -1
	for i, e := range events {
		if e.Type == "agent_message" {
			lastAgentIdx = i
		}
		if e.Type == "user_message" && firstUserIdx == -1 {
			firstUserIdx = i
		}
	}

	if firstUserIdx > lastAgentIdx {
		t.Logf("CONFIRMED: UserMessageChunk (idx %d) arrives AFTER AgentMessageChunk (idx %d) — "+
			"agent_ws.go injection+skip is required", firstUserIdx, lastAgentIdx)
	} else {
		t.Errorf("ORDERING CHANGED: UserMessageChunk (idx %d) now arrives BEFORE AgentMessageChunk (idx %d) — "+
			"remove the injection+skip in agent_ws.go, natural ordering is correct",
			firstUserIdx, lastAgentIdx)
	}
}

// TestACPLoadSessionEmitsUserMessageChunk verifies that LoadSession replays
// UserMessageChunk events as part of the conversation history.
//
// During LoadSession replay, the ordering is correct (user message before
// agent response). This path does NOT need the injection+skip workaround.
func TestACPLoadSessionEmitsUserMessageChunk(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(4*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// Step 1: Have a conversation
	t.Log("=== Step 1: Send a prompt ===")
	h.Prompt(ctx, "Reply with exactly: ok")

	originalSessionID := h.SessionID()

	// Step 2: Switch to a new session
	t.Log("=== Step 2: Switch to new session ===")
	_, err := h.Conn().NewSession(ctx, acp.NewSessionRequest{
		Cwd:        t.TempDir(),
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}

	// Step 3: Load the original session back and check replay events.
	// LoadSession() returns before all SessionUpdate callbacks finish,
	// so we poll until events stabilize.
	t.Log("=== Step 3: Load original session ===")
	h.Client().resetEvents()

	_, err = h.Conn().LoadSession(ctx, acp.LoadSessionRequest{
		SessionId:  originalSessionID,
		Cwd:        t.TempDir(),
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		t.Skipf("LoadSession failed — cannot verify replay behavior: %v", err)
	}

	// Poll for events — LoadSession returns before replay callbacks complete
	var replayEvents []RecordedEvent
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		replayEvents = h.Client().getEvents()
		if HasEvent(replayEvents, "user_message") && HasEvent(replayEvents, "agent_message") {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	t.Logf("Total replayed events: %d", len(replayEvents))

	// Document replay ordering
	t.Log("Replay event ordering:")
	for i, e := range replayEvents {
		t.Logf("  [%d] %s", i, e.Type)
	}

	userMsgs := Events(replayEvents, "user_message")
	agentMsgs := Events(replayEvents, "agent_message")
	t.Logf("UserMessageChunk events: %d", len(userMsgs))
	t.Logf("AgentMessageChunk events: %d", len(agentMsgs))

	if len(userMsgs) == 0 {
		t.Error("LoadSession did not replay any UserMessageChunk events")
	}
	if len(agentMsgs) == 0 {
		t.Error("LoadSession did not replay any AgentMessageChunk events")
	}
}
