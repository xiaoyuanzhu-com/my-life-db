package agentsdk

import "testing"

// SendToClient exists so delivery receipts don't enter rawMessages. Anything
// appended there is replayed in full on every subsequent connect, which is
// what turns a one-shot receipt into a signal the client sees again on every
// reopen. A fresh client must therefore see no trace of it.
func TestSendToClient_IsEphemeralAndNotReplayed(t *testing.T) {
	state := NewSessionState("session-1")
	client := NewWSClient("client-1", 0)
	state.AddClient(client)

	state.AppendAndBroadcast(testFrame(`{"sessionUpdate":"user_message_chunk","messageId":"m-1","content":{"type":"text","text":"hi"}}`))
	state.SendToClient(client, SynthPromptAck("m-1"))

	got := state.Drain(client)
	if len(got) != 2 {
		t.Fatalf("got %d frames, want 2 (ack + stored chunk)", len(got))
	}
	if string(got[0]) != `{"messageId":"m-1","type":"prompt.ack"}` {
		t.Fatalf("first frame = %s, want the ephemeral ack ahead of stored frames", got[0])
	}

	// Same client, nothing new: the ack must not come back.
	if again := state.Drain(client); again != nil {
		t.Fatalf("re-drain returned %d frames, want none", len(again))
	}

	// A reconnecting client replays from cursor 0 and must see history only.
	fresh := NewWSClient("client-2", 0)
	state.AddClient(fresh)
	replay := state.Drain(fresh)
	if len(replay) != 1 {
		t.Fatalf("replay returned %d frames, want 1 (the stored chunk only)", len(replay))
	}
	if state.MessageCount() != 1 {
		t.Fatalf("rawMessages = %d, want 1 — the ack must not be stored", state.MessageCount())
	}
}

// A receipt addressed to a client that has already disconnected is dropped
// rather than buffered onto a WSClient nobody will drain again.
func TestSendToClient_DroppedForDetachedClient(t *testing.T) {
	state := NewSessionState("session-1")
	client := NewWSClient("client-1", 0)
	state.AddClient(client)
	state.RemoveClient(client)

	state.SendToClient(client, SynthPromptAck("m-1"))

	if got := state.Drain(client); got != nil {
		t.Fatalf("got %d frames for a detached client, want none", len(got))
	}
}
