package claude

import (
	"encoding/json"
	"sync"
	"testing"
)

// =============================================================================
// Test Helpers
// =============================================================================

// makeMsg creates a raw JSON message with the given type.
// For stream_event, uses a struct to ensure "type" appears early in the JSON
// (isStreamEvent checks the first 100 bytes). With map[string]interface{},
// json.Marshal sorts keys alphabetically, putting "event" before "type".
func makeMsg(msgType string) []byte {
	if msgType == "stream_event" {
		type streamEvent struct {
			Type  string `json:"type"`
			Event struct {
				Type string `json:"type"`
			} `json:"event"`
		}
		se := streamEvent{Type: "stream_event"}
		se.Event.Type = "content_block_delta"
		data, _ := json.Marshal(se)
		return data
	}
	data, _ := json.Marshal(map[string]string{"type": msgType})
	return data
}

// makeMsgWithUUID creates a raw JSON message with type and UUID.
func makeMsgWithUUID(msgType, uuid string) []byte {
	data, _ := json.Marshal(map[string]string{"type": msgType, "uuid": uuid})
	return data
}

// msgTypes extracts the "type" field from each raw JSON message for easy assertion.
func msgTypes(msgs [][]byte) []string {
	var types []string
	for _, msg := range msgs {
		var envelope struct {
			Type string `json:"type"`
		}
		json.Unmarshal(msg, &envelope)
		types = append(types, envelope.Type)
	}
	return types
}

// createTestSession creates a minimal Session for page tests.
func createTestSession() *Session {
	return &Session{
		seenUUIDs: make(map[string]bool),
	}
}

// =============================================================================
// materializePageSlice Tests
// =============================================================================

func TestMaterializePageSlice_SealedPage_ExcludesAllStreamEvents(t *testing.T) {
	slice := [][]byte{
		makeMsg("stream_event"),
		makeMsg("stream_event"),
		makeMsg("assistant"),
		makeMsg("result"),
	}

	got := materializePageSlice(slice, true)
	types := msgTypes(got)

	if len(types) != 2 {
		t.Fatalf("expected 2 messages, got %d: %v", len(types), types)
	}
	if types[0] != "assistant" || types[1] != "result" {
		t.Errorf("expected [assistant, result], got %v", types)
	}
}

func TestMaterializePageSlice_OpenPage_ExcludesClosedStreamEvents(t *testing.T) {
	// One completed streaming cycle, no active stream
	slice := [][]byte{
		makeMsg("stream_event"),
		makeMsg("stream_event"),
		makeMsg("assistant"),
		makeMsg("result"),
	}

	got := materializePageSlice(slice, false)
	types := msgTypes(got)

	if len(types) != 2 {
		t.Fatalf("expected 2 messages (closed stream_events excluded), got %d: %v", len(types), types)
	}
	if types[0] != "assistant" || types[1] != "result" {
		t.Errorf("expected [assistant, result], got %v", types)
	}
}

func TestMaterializePageSlice_OpenPage_KeepsActiveStreamEvents(t *testing.T) {
	// Active streaming — stream_events at tail with no assistant
	slice := [][]byte{
		makeMsg("user"),
		makeMsg("stream_event"),
		makeMsg("stream_event"),
	}

	got := materializePageSlice(slice, false)
	types := msgTypes(got)

	if len(types) != 3 {
		t.Fatalf("expected 3 messages (active stream_events kept), got %d: %v", len(types), types)
	}
	if types[0] != "user" || types[1] != "stream_event" || types[2] != "stream_event" {
		t.Errorf("expected [user, stream_event, stream_event], got %v", types)
	}
}

func TestMaterializePageSlice_OpenPage_MultipleCycles(t *testing.T) {
	// Two completed cycles + one active stream
	slice := [][]byte{
		makeMsg("stream_event"),   // closed (assistant₁)
		makeMsg("stream_event"),   // closed (assistant₁)
		makeMsg("assistant"),      // closes first run
		makeMsg("result"),
		makeMsg("user"),
		makeMsg("stream_event"),   // closed (assistant₂)
		makeMsg("stream_event"),   // closed (assistant₂)
		makeMsg("assistant"),      // closes second run
		makeMsg("result"),
		makeMsg("stream_event"),   // active (no assistant after)
		makeMsg("stream_event"),   // active
	}

	got := materializePageSlice(slice, false)
	types := msgTypes(got)

	expected := []string{"assistant", "result", "user", "assistant", "result", "stream_event", "stream_event"}
	if len(types) != len(expected) {
		t.Fatalf("expected %d messages, got %d: %v", len(expected), len(types), types)
	}
	for i, exp := range expected {
		if types[i] != exp {
			t.Errorf("index %d: expected %s, got %s", i, exp, types[i])
		}
	}
}

func TestMaterializePageSlice_OpenPage_MultipleCyclesNoActiveStream(t *testing.T) {
	// Two completed cycles, idle session — all stream_events should be evicted
	slice := [][]byte{
		makeMsg("stream_event"),   // closed
		makeMsg("stream_event"),   // closed
		makeMsg("assistant"),
		makeMsg("result"),
		makeMsg("user"),
		makeMsg("stream_event"),   // closed
		makeMsg("stream_event"),   // closed
		makeMsg("assistant"),
		makeMsg("result"),
	}

	got := materializePageSlice(slice, false)
	types := msgTypes(got)

	expected := []string{"assistant", "result", "user", "assistant", "result"}
	if len(types) != len(expected) {
		t.Fatalf("expected %d messages, got %d: %v", len(expected), len(types), types)
	}
	for i, exp := range expected {
		if types[i] != exp {
			t.Errorf("index %d: expected %s, got %s", i, exp, types[i])
		}
	}
}

func TestMaterializePageSlice_EmptySlice(t *testing.T) {
	got := materializePageSlice(nil, false)
	if len(got) != 0 {
		t.Errorf("expected empty result, got %d messages", len(got))
	}

	got = materializePageSlice(nil, true)
	if len(got) != 0 {
		t.Errorf("expected empty result for sealed, got %d messages", len(got))
	}
}

func TestMaterializePageSlice_NoStreamEvents(t *testing.T) {
	slice := [][]byte{
		makeMsg("user"),
		makeMsg("assistant"),
		makeMsg("result"),
	}

	got := materializePageSlice(slice, false)
	types := msgTypes(got)
	if len(types) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(types))
	}

	got = materializePageSlice(slice, true)
	types = msgTypes(got)
	if len(types) != 3 {
		t.Fatalf("expected 3 messages for sealed, got %d", len(types))
	}
}

func TestMaterializePageSlice_OnlyActiveStreamEvents(t *testing.T) {
	// Page has only stream_events (fresh start, mid-stream)
	slice := [][]byte{
		makeMsg("stream_event"),
		makeMsg("stream_event"),
		makeMsg("stream_event"),
	}

	got := materializePageSlice(slice, false)
	types := msgTypes(got)
	if len(types) != 3 {
		t.Fatalf("expected 3 active stream_events, got %d: %v", len(types), types)
	}
}

func TestMaterializePageSlice_MixedTypes(t *testing.T) {
	// Includes progress, system, rate_limit_event — all should pass through
	slice := [][]byte{
		makeMsg("system"),
		makeMsg("stream_event"),   // closed
		makeMsg("stream_event"),   // closed
		makeMsg("assistant"),
		makeMsg("progress"),
		makeMsg("result"),
		makeMsg("rate_limit_event"),
	}

	got := materializePageSlice(slice, false)
	types := msgTypes(got)

	expected := []string{"system", "assistant", "progress", "result", "rate_limit_event"}
	if len(types) != len(expected) {
		t.Fatalf("expected %d messages, got %d: %v", len(expected), len(types), types)
	}
	for i, exp := range expected {
		if types[i] != exp {
			t.Errorf("index %d: expected %s, got %s", i, exp, types[i])
		}
	}
}

// =============================================================================
// GetPage / GetPageRange Integration Tests
// =============================================================================

func TestGetPage_SealedPage(t *testing.T) {
	s := createTestSession()
	s.rawMessages = [][]byte{
		makeMsg("user"),
		makeMsg("stream_event"),
		makeMsg("stream_event"),
		makeMsg("assistant"),
		makeMsg("result"),
	}
	// Seal at index 5 (all messages in page 0)
	s.pageBreaks = []int{5}
	s.currentPageStart = 5
	s.currentPageCount = 0

	msgs, sealed := s.GetPage(0)
	if !sealed {
		t.Error("expected page 0 to be sealed")
	}
	types := msgTypes(msgs)
	expected := []string{"user", "assistant", "result"}
	if len(types) != len(expected) {
		t.Fatalf("expected %d messages, got %d: %v", len(expected), len(types), types)
	}
	for i, exp := range expected {
		if types[i] != exp {
			t.Errorf("index %d: expected %s, got %s", i, exp, types[i])
		}
	}
}

func TestGetPage_OpenPage_IdleSession(t *testing.T) {
	s := createTestSession()
	s.rawMessages = [][]byte{
		makeMsg("user"),
		makeMsg("stream_event"),
		makeMsg("stream_event"),
		makeMsg("assistant"),
		makeMsg("result"),
	}
	// No page breaks — all in open page 0
	s.pageBreaks = nil
	s.currentPageStart = 0
	s.currentPageCount = 3 // user + assistant + result
	s.hasOpenStream = false

	msgs, sealed := s.GetPage(0)
	if sealed {
		t.Error("expected page 0 to be open (not sealed)")
	}
	types := msgTypes(msgs)
	// Closed stream_events should be excluded
	expected := []string{"user", "assistant", "result"}
	if len(types) != len(expected) {
		t.Fatalf("expected %d messages, got %d: %v", len(expected), len(types), types)
	}
	for i, exp := range expected {
		if types[i] != exp {
			t.Errorf("index %d: expected %s, got %s", i, exp, types[i])
		}
	}
}

func TestGetPage_OpenPage_ActiveStreaming(t *testing.T) {
	s := createTestSession()
	s.rawMessages = [][]byte{
		makeMsg("user"),
		makeMsg("stream_event"),   // closed
		makeMsg("assistant"),
		makeMsg("result"),
		makeMsg("user"),
		makeMsg("stream_event"),   // active
		makeMsg("stream_event"),   // active
	}
	s.pageBreaks = nil
	s.currentPageStart = 0
	s.hasOpenStream = true

	msgs, sealed := s.GetPage(0)
	if sealed {
		t.Error("expected open page")
	}
	types := msgTypes(msgs)
	expected := []string{"user", "assistant", "result", "user", "stream_event", "stream_event"}
	if len(types) != len(expected) {
		t.Fatalf("expected %d messages, got %d: %v", len(expected), len(types), types)
	}
	for i, exp := range expected {
		if types[i] != exp {
			t.Errorf("index %d: expected %s, got %s", i, exp, types[i])
		}
	}
}

func TestGetPage_OutOfRange(t *testing.T) {
	s := createTestSession()
	s.rawMessages = [][]byte{makeMsg("user")}
	s.pageBreaks = nil

	msgs, _ := s.GetPage(-1)
	if msgs != nil {
		t.Error("expected nil for negative page")
	}

	msgs, _ = s.GetPage(1)
	if msgs != nil {
		t.Error("expected nil for page beyond range")
	}
}

func TestGetPageRange_BurstWithSealedAndOpenPage(t *testing.T) {
	s := createTestSession()

	// Build raw messages: sealed page 0 (with stream_events) + open page 1 (idle, with closed stream_events)
	s.rawMessages = [][]byte{
		// Page 0 (sealed)
		makeMsg("user"),
		makeMsg("stream_event"),
		makeMsg("assistant"),
		makeMsg("result"),
		// Page 1 (open, idle)
		makeMsg("user"),
		makeMsg("stream_event"),
		makeMsg("stream_event"),
		makeMsg("assistant"),
		makeMsg("result"),
	}
	s.pageBreaks = []int{4} // Sealed page 0 ends at index 4
	s.currentPageStart = 4
	s.currentPageCount = 3
	s.hasOpenStream = false

	msgs := s.GetPageRange(0, 2)
	types := msgTypes(msgs)

	// Page 0 sealed: stream_event excluded → user, assistant, result
	// Page 1 open, idle: closed stream_events excluded → user, assistant, result
	expected := []string{"user", "assistant", "result", "user", "assistant", "result"}
	if len(types) != len(expected) {
		t.Fatalf("expected %d messages, got %d: %v", len(expected), len(types), types)
	}
	for i, exp := range expected {
		if types[i] != exp {
			t.Errorf("index %d: expected %s, got %s", i, exp, types[i])
		}
	}
}

func TestGetPageRange_BurstMidStream(t *testing.T) {
	s := createTestSession()

	s.rawMessages = [][]byte{
		// Page 0 (sealed)
		makeMsg("user"),
		makeMsg("assistant"),
		makeMsg("result"),
		// Page 1 (open, mid-stream)
		makeMsg("user"),
		makeMsg("stream_event"),
		makeMsg("stream_event"),
	}
	s.pageBreaks = []int{3}
	s.currentPageStart = 3
	s.hasOpenStream = true

	msgs := s.GetPageRange(0, 2)
	types := msgTypes(msgs)

	// Page 0 sealed: user, assistant, result
	// Page 1 open, active: user, stream_event, stream_event (all kept)
	expected := []string{"user", "assistant", "result", "user", "stream_event", "stream_event"}
	if len(types) != len(expected) {
		t.Fatalf("expected %d messages, got %d: %v", len(expected), len(types), types)
	}
	for i, exp := range expected {
		if types[i] != exp {
			t.Errorf("index %d: expected %s, got %s", i, exp, types[i])
		}
	}
}

func TestGetPageRange_ClampsBounds(t *testing.T) {
	s := createTestSession()
	s.rawMessages = [][]byte{makeMsg("user")}
	s.pageBreaks = nil

	// fromPage < 0 should clamp to 0
	msgs := s.GetPageRange(-5, 1)
	if len(msgs) != 1 {
		t.Errorf("expected 1 message, got %d", len(msgs))
	}

	// toPage > totalPages should clamp
	msgs = s.GetPageRange(0, 100)
	if len(msgs) != 1 {
		t.Errorf("expected 1 message, got %d", len(msgs))
	}
}

// =============================================================================
// Concurrency Test
// =============================================================================

func TestGetPage_ConcurrentAccess(t *testing.T) {
	s := createTestSession()
	s.rawMessages = [][]byte{
		makeMsg("user"),
		makeMsg("stream_event"),
		makeMsg("assistant"),
		makeMsg("result"),
	}
	s.pageBreaks = nil

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			msgs, _ := s.GetPage(0)
			types := msgTypes(msgs)
			// Should always get 3 messages (closed stream_event excluded)
			if len(types) != 3 {
				t.Errorf("expected 3 messages, got %d: %v", len(types), types)
			}
		}()
	}
	wg.Wait()
}
