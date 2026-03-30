//go:build acptest

package acptest

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

// TestACPLoadSessionReplayCompleteness tests whether LoadSession replays ALL
// frame types from the original conversation, including:
// - user_message_chunk
// - agent_message_chunk (text-only responses)
// - agent_thought_chunk
// - tool_call
// - tool_call_update (completed status)
//
// Known issue: tool_call_update and post-tool agent_message_chunk frames are
// dropped during replay due to a parentUuid chain traversal bug in
// @anthropic-ai/claude-agent-sdk's getSessionMessages(). PostToolUse hook
// progress events create alternative branches that share the same parent as
// tool_result entries, causing the chain walk to skip the tool_result and any
// subsequent assistant text.
//
// Upstream: https://github.com/anthropics/claude-code/issues/31330
//
// When the SDK fix ships, this test should start passing without changes on
// our end — claude-agent-acp's toAcpNotifications() correctly produces all
// frame types; the input data from getSessionMessages() is just incomplete.
func TestACPLoadSessionReplayCompleteness(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(5*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	// Turn 1: Simple text response (no tools)
	t.Log("=== Turn 1: Text-only response ===")
	_, events1 := h.Prompt(ctx, "Reply with exactly: 'MARKER_ALPHA_123'. Nothing else.")
	logEventSummary(t, "Turn 1 live", events1)

	// Turn 2: Force tool usage (should produce tool_call + tool_call_update)
	t.Log("=== Turn 2: Tool call response ===")
	_, events2 := h.Prompt(ctx, "Use the Bash tool to run 'echo MARKER_BETA_456'. Then say 'Done with beta.'")
	logEventSummary(t, "Turn 2 live", events2)

	// Turn 3: Another text-only response
	t.Log("=== Turn 3: Another text-only response ===")
	_, events3 := h.Prompt(ctx, "Reply with exactly: 'MARKER_GAMMA_789'. Nothing else.")
	logEventSummary(t, "Turn 3 live", events3)

	originalSessionID := h.SessionID()
	t.Logf("Original session: %s", originalSessionID)

	// Record live frame type counts for comparison
	allLive := append(append(events1, events2...), events3...)
	liveCounts := countEventTypes(allLive)
	t.Log("=== Live session frame type counts ===")
	for typ, count := range liveCounts {
		t.Logf("  %s: %d", typ, count)
	}

	// Switch to new session
	t.Log("=== Switching to new session ===")
	_, err := h.Conn().NewSession(ctx, acp.NewSessionRequest{
		Cwd:        t.TempDir(),
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		t.Fatalf("NewSession (switch): %v", err)
	}

	// Load back original session — this is what we're testing
	t.Log("=== LoadSession replay ===")
	h.Client().resetEvents()

	_, err = h.Conn().LoadSession(ctx, acp.LoadSessionRequest{
		SessionId:  originalSessionID,
		Cwd:        t.TempDir(),
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		t.Fatalf("LoadSession failed: %v", err)
	}

	replayEvents := h.Client().getEvents()
	replayCounts := countEventTypes(replayEvents)
	t.Log("=== Replay frame type counts ===")
	for typ, count := range replayCounts {
		t.Logf("  %s: %d", typ, count)
	}

	// Log full replay event sequence for debugging
	t.Log("=== Full replay event sequence ===")
	for i, evt := range replayEvents {
		preview := ""
		switch evt.Type {
		case "agent_message":
			if evt.AgentMessageChunk != nil && evt.AgentMessageChunk.Content.Text != nil {
				preview = truncate(evt.AgentMessageChunk.Content.Text.Text, 100)
			}
		case "user_message":
			if evt.UserMessageChunk != nil && evt.UserMessageChunk.Content.Text != nil {
				preview = truncate(evt.UserMessageChunk.Content.Text.Text, 100)
			}
		case "tool_call":
			if evt.ToolCall != nil {
				preview = fmt.Sprintf("id=%s title=%q status=%s", evt.ToolCall.ToolCallId, evt.ToolCall.Title, evt.ToolCall.Status)
			}
		case "tool_call_update":
			if evt.ToolCallUpdate != nil {
				status := "nil"
				if evt.ToolCallUpdate.Status != nil {
					status = string(*evt.ToolCallUpdate.Status)
				}
				preview = fmt.Sprintf("id=%s status=%s", evt.ToolCallUpdate.ToolCallId, status)
			}
		}
		t.Logf("  [%d] seq=%d type=%s %s", i, evt.Seq, evt.Type, preview)
	}

	// === Assertions ===

	t.Log("=== Completeness checks ===")

	// Check 1: Are user messages replayed?
	liveUsers := liveCounts["user_message"]
	replayUsers := replayCounts["user_message"]
	t.Logf("User messages — live: %d, replay: %d", liveUsers, replayUsers)
	// Note: live Prompt() doesn't echo user messages, but LoadSession should replay them
	if replayUsers < 3 {
		t.Logf("WARNING: Expected at least 3 user messages in replay, got %d", replayUsers)
	}

	// Check 2: Are agent text messages replayed?
	liveAgent := liveCounts["agent_message"]
	replayAgent := replayCounts["agent_message"]
	t.Logf("Agent messages — live: %d, replay: %d", liveAgent, replayAgent)

	// Check if markers are present in replayed text
	replayText := AgentText(replayEvents)
	hasAlpha := containsStr(replayText, "MARKER_ALPHA_123")
	hasBeta := containsStr(replayText, "beta") || containsStr(replayText, "BETA") || containsStr(replayText, "Done")
	hasGamma := containsStr(replayText, "MARKER_GAMMA_789")
	t.Logf("Marker ALPHA in replay: %v", hasAlpha)
	t.Logf("Marker BETA text in replay: %v", hasBeta)
	t.Logf("Marker GAMMA in replay: %v", hasGamma)

	if !hasAlpha {
		t.Error("FINDING: Turn 1 text-only response (MARKER_ALPHA_123) MISSING from replay")
	}
	if !hasGamma {
		t.Error("FINDING: Turn 3 text-only response (MARKER_GAMMA_789) MISSING from replay")
	}

	// Check 3: Are tool_call frames replayed?
	liveToolCalls := liveCounts["tool_call"]
	replayToolCalls := replayCounts["tool_call"]
	t.Logf("Tool calls — live: %d, replay: %d", liveToolCalls, replayToolCalls)

	if liveToolCalls > 0 && replayToolCalls == 0 {
		t.Error("FINDING: tool_call frames are MISSING from replay")
	}

	// Check 4: Are tool_call_update frames replayed?
	liveToolUpdates := liveCounts["tool_call_update"]
	replayToolUpdates := replayCounts["tool_call_update"]
	t.Logf("Tool call updates — live: %d, replay: %d", liveToolUpdates, replayToolUpdates)

	if liveToolCalls > 0 && replayToolUpdates == 0 {
		t.Error("FINDING: tool_call_update frames are MISSING from replay — tools will show as 'pending' forever")
	}

	// Check 5: Thought chunks
	liveThoughts := liveCounts["agent_thought"]
	replayThoughts := replayCounts["agent_thought"]
	t.Logf("Thought chunks — live: %d, replay: %d", liveThoughts, replayThoughts)

	// Summary
	t.Log("=== SUMMARY ===")
	allTypes := map[string]bool{}
	for k := range liveCounts {
		allTypes[k] = true
	}
	for k := range replayCounts {
		allTypes[k] = true
	}

	for typ := range allTypes {
		live := liveCounts[typ]
		replay := replayCounts[typ]
		status := "OK"
		if live > 0 && replay == 0 {
			status = "MISSING IN REPLAY"
		} else if replay < live {
			status = "FEWER IN REPLAY"
		}
		t.Logf("  %-25s live=%-4d replay=%-4d %s", typ, live, replay, status)
	}
}

// --- Helpers ---

func countEventTypes(events []RecordedEvent) map[string]int {
	counts := map[string]int{}
	for _, e := range events {
		counts[e.Type]++
	}
	return counts
}

func containsStr(haystack, needle string) bool {
	return len(haystack) > 0 && len(needle) > 0 && (indexOf(haystack, needle) >= 0)
}

func indexOf(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}

func logEventSummary(t *testing.T, label string, events []RecordedEvent) {
	t.Helper()
	counts := countEventTypes(events)
	parts := make([]string, 0, len(counts))
	for typ, count := range counts {
		parts = append(parts, fmt.Sprintf("%s=%d", typ, count))
	}
	t.Logf("%s: %d events (%v)", label, len(events), parts)

	text := AgentText(events)
	if text != "" {
		t.Logf("  agent text: %q", truncate(text, 150))
	}
}

// unused — needed if helpers above reference json
var _ = json.Marshal
