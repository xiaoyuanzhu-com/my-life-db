package agentsdk

import (
	"bytes"
	"encoding/json"
	"testing"
)

func testFrame(value string) []byte {
	return []byte(value)
}

func frameText(t *testing.T, frame []byte) string {
	t.Helper()
	var envelope struct {
		Content struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(frame, &envelope); err != nil {
		t.Fatalf("unmarshal frame: %v", err)
	}
	return envelope.Content.Text
}

func TestCompactCompletedTurnFrames_MergesAdjacentTextChunks(t *testing.T) {
	frames := [][]byte{
		testFrame(`{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"question"}}`),
		testFrame(`{"type":"turn.start"}`),
		testFrame(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hel"}}`),
		testFrame(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"lo"}}`),
		testFrame(`{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"think"}}`),
		testFrame(`{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"ing"}}`),
		testFrame(`{"sessionUpdate":"tool_call","toolCallId":"tool-1"}`),
		testFrame(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}`),
		testFrame(`{"type":"turn.complete","stopReason":"end_turn"}`),
	}

	got := CompactCompletedTurnFrames(frames)
	if len(got) != 7 {
		t.Fatalf("got %d frames, want 7", len(got))
	}
	if text := frameText(t, got[2]); text != "hello" {
		t.Fatalf("merged agent text = %q, want hello", text)
	}
	if text := frameText(t, got[3]); text != "thinking" {
		t.Fatalf("merged thought text = %q, want thinking", text)
	}
	if frameDiscriminator(got[4]) != "tool_call" {
		t.Fatalf("tool boundary moved or disappeared: %s", got[4])
	}
	if text := frameText(t, got[5]); text != "done" {
		t.Fatalf("post-tool text = %q, want done", text)
	}
}

func TestCompactCompletedTurnFrames_LeavesIncompleteTurnUnchanged(t *testing.T) {
	frames := [][]byte{
		testFrame(`{"type":"turn.start"}`),
		testFrame(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"live "}}`),
		testFrame(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"update"}}`),
	}

	got := CompactCompletedTurnFrames(frames)
	if len(got) != len(frames) {
		t.Fatalf("got %d frames, want %d", len(got), len(frames))
	}
	for i := range frames {
		if !bytes.Equal(got[i], frames[i]) {
			t.Fatalf("frame %d changed during incomplete turn: %s", i, got[i])
		}
	}
}

func TestCompactCompletedTurnFrames_PreservesMetadataBoundaries(t *testing.T) {
	frames := [][]byte{
		testFrame(`{"type":"turn.start"}`),
		testFrame(`{"_meta":{"claudeCode":{"parentToolUseId":"parent-1"}},"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"one"}}`),
		testFrame(`{"_meta":{"claudeCode":{"parentToolUseId":"parent-2"}},"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"two"}}`),
		testFrame(`{"type":"turn.complete","stopReason":"end_turn"}`),
	}

	got := CompactCompletedTurnFrames(frames)
	if len(got) != len(frames) {
		t.Fatalf("metadata-distinct chunks merged: got %d frames, want %d", len(got), len(frames))
	}
}

func TestCompactCompletedTurnFrames_RequiresExplicitTurnBoundaries(t *testing.T) {
	frames := [][]byte{
		testFrame(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"historical "}}`),
		testFrame(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"text"}}`),
		testFrame(`{"type":"turn.complete","stopReason":"end_turn"}`),
	}

	got := CompactCompletedTurnFrames(frames)
	if len(got) != len(frames) {
		t.Fatalf("frames without turn.start were compacted: got %d, want %d", len(got), len(frames))
	}
}

func TestLoadHistoricalFrames_CompactsCompletedTurns(t *testing.T) {
	state := NewSessionState("session-1")
	client := NewWSClient("client-1", 0)
	state.AddClient(client)

	state.LoadHistoricalFrames([][]byte{
		testFrame(`{"type":"turn.start"}`),
		testFrame(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"history "}}`),
		testFrame(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"loaded"}}`),
		testFrame(`{"type":"turn.complete","stopReason":"end_turn"}`),
	})

	got := state.Drain(client)
	if len(got) != 3 {
		t.Fatalf("got %d replay frames, want 3", len(got))
	}
	if text := frameText(t, got[1]); text != "history loaded" {
		t.Fatalf("merged replay text = %q, want history loaded", text)
	}
}

// Outbox ack recovery on reconnect depends on every user_message_chunk (and
// its messageId) surviving replay compaction: a client that re-sends an
// inflight prompt is told it landed either by the ephemeral prompt.ack or by
// seeing its own chunk come back in the replay. Drop the chunk here and the
// item stays inflight forever, so this invariant is load-bearing — not an
// incidental property of the current mergeable-frame filter.
func TestCompactCompletedTurnFrames_PreservesUserMessageChunks(t *testing.T) {
	frames := [][]byte{
		testFrame(`{"type":"turn.start"}`),
		testFrame(`{"sessionUpdate":"user_message_chunk","messageId":"m-1","content":{"type":"text","text":"first"}}`),
		testFrame(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"a"}}`),
		testFrame(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"b"}}`),
		testFrame(`{"sessionUpdate":"user_message_chunk","messageId":"m-2","content":{"type":"text","text":"second"}}`),
		testFrame(`{"type":"turn.complete","stopReason":"end_turn"}`),
	}

	got := CompactCompletedTurnFrames(frames)

	seen := map[string]string{}
	for _, frame := range got {
		var envelope struct {
			SessionUpdate string `json:"sessionUpdate"`
			MessageID     string `json:"messageId"`
			Content       struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal(frame, &envelope); err != nil {
			t.Fatalf("unmarshal frame: %v", err)
		}
		if envelope.SessionUpdate == "user_message_chunk" {
			seen[envelope.MessageID] = envelope.Content.Text
		}
	}

	if len(seen) != 2 {
		t.Fatalf("got %d user_message_chunk frames after compaction, want 2 (%v)", len(seen), seen)
	}
	if seen["m-1"] != "first" || seen["m-2"] != "second" {
		t.Fatalf("user chunks altered by compaction: %v", seen)
	}
}
