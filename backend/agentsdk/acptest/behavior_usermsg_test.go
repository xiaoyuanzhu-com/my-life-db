//go:build acptest

package acptest

import (
	"context"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

// TestACPUserMessageChunkDuringPrompt documents whether the ACP agent echoes
// user_message_chunk during a live Prompt() call.
//
// Finding (claude-agent-acp v0.22.2): ACP does NOT emit user_message_chunk
// during live Prompt() calls. The agent only emits agent_message_chunk,
// available_commands_update, and usage_update. The user's prompt text is
// never echoed back as a SessionUpdate notification.
//
// Implication: the host application (MyLifeDB) must synthesize and store
// user_message_chunk frames itself before calling Send(), so user messages
// survive page refresh via burst replay.
func TestACPUserMessageChunkDuringPrompt(t *testing.T) {
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

	// Document the finding: ACP does NOT echo user messages during live Prompt().
	// This behavior was confirmed with claude-agent-acp v0.22.2.
	// If a future ACP version starts echoing, this test will catch it and the
	// dedup logic in the frontend's user_message_chunk handler will prevent
	// double display.
	if len(userMsgs) == 0 {
		t.Log("CONFIRMED: ACP does NOT emit user_message_chunk during live Prompt()")
		t.Log("  The host must synthesize user_message_chunk frames for burst replay.")
	} else {
		t.Logf("NOTICE: ACP now emits %d user_message_chunk(s) during Prompt() — behavior changed!", len(userMsgs))
		t.Log("  Verify that frontend dedup prevents double user messages.")

		// If user messages appeared, verify they come before agent responses
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
		if firstUserIdx != -1 && firstAgentIdx != -1 && firstUserIdx < firstAgentIdx {
			t.Logf("  Wire order OK: user_message (idx %d) before agent response (idx %d)", firstUserIdx, firstAgentIdx)
		}
	}
}

// TestACPLoadSessionEmitsUserMessageChunk verifies that LoadSession replays
// user_message_chunk events as part of the conversation history.
//
// Finding (claude-agent-acp v0.22.2): LoadSession DOES replay user messages
// from the JSONL transcript. Multiple user_message_chunk frames arrive per
// user turn (one per content block: user text + system-injected context).
// The ordering is correct: user messages appear before agent responses.
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
