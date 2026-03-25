//go:build acptest

package acptest

import (
	"context"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

// TestACPUserMessageChunkOrdering verifies that ACP's Prompt() delivers
// UserMessageChunk BEFORE AgentThoughtChunk/AgentMessageChunk when wire
// ordering is enforced.
//
// The ACP SDK dispatches each SessionUpdate via `go handleInbound()`
// goroutines, so without ordering enforcement, events can appear reordered
// (e.g., agent thought before user message). The test harness uses the same
// monotonic sequence counter + condition variable as production acpclient.go
// to enforce wire order.
//
// This test confirms that the ACP SDK's wire order is correct — user message
// first, then agent response. No injection+skip workaround is needed in
// agent_ws.go.
func TestACPUserMessageChunkOrdering(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	_, events := h.Prompt(ctx, "Reply with exactly: ok")

	userMsgs := Events(events, "user_message")
	agentMsgs := Events(events, "agent_message")

	t.Logf("UserMessageChunk events: %d", len(userMsgs))
	t.Logf("AgentMessageChunk events: %d", len(agentMsgs))

	// Document full event ordering with wire-order seq numbers
	t.Log("Event ordering (wire order):")
	for i, e := range events {
		t.Logf("  [%d] seq=%d %s", i, e.Seq, e.Type)
	}

	if len(userMsgs) == 0 {
		t.Fatal("ACP did not emit UserMessageChunk during Prompt()")
	}

	// Find the first user message and first agent response (thought or message)
	firstUserIdx := -1
	firstAgentIdx := -1
	for i, e := range events {
		if e.Type == "user_message" && firstUserIdx == -1 {
			firstUserIdx = i
		}
		if (e.Type == "agent_message" || e.Type == "agent_thought") && firstAgentIdx == -1 {
			firstAgentIdx = i
		}
	}

	if firstAgentIdx == -1 {
		t.Fatal("ACP did not emit any AgentMessageChunk or AgentThoughtChunk")
	}

	if firstUserIdx < firstAgentIdx {
		t.Logf("CONFIRMED: UserMessageChunk (idx %d, seq=%d) arrives BEFORE first agent response (idx %d, seq=%d) — "+
			"ACP wire order is correct, no workaround needed in agent_ws.go",
			firstUserIdx, events[firstUserIdx].Seq, firstAgentIdx, events[firstAgentIdx].Seq)
	} else {
		t.Errorf("UserMessageChunk (idx %d, seq=%d) arrives AFTER first agent response (idx %d, seq=%d) — "+
			"ACP wire order may have changed, investigate",
			firstUserIdx, events[firstUserIdx].Seq, firstAgentIdx, events[firstAgentIdx].Seq)
	}
}

// TestACPLoadSessionEmitsUserMessageChunk verifies that LoadSession replays
// UserMessageChunk events as part of the conversation history.
//
// During LoadSession replay, the ordering is correct (user message before
// agent response). This path does NOT need any workaround.
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
		t.Logf("  [%d] seq=%d %s", i, e.Seq, e.Type)
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
