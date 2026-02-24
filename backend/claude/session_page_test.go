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

// makeLargeMsg creates a raw JSON message with the given type and at least
// minBytes in total size by including a padding field.
func makeLargeMsg(msgType string, minBytes int) []byte {
	// First, marshal without padding to measure the fixed overhead.
	base, _ := json.Marshal(map[string]string{"type": msgType, "padding": ""})
	overhead := len(base) // e.g. {"padding":"","type":"user"} ≈ 28 bytes
	padLen := minBytes - overhead
	if padLen < 0 {
		padLen = 0
	}
	padding := make([]byte, padLen)
	for i := range padding {
		padding[i] = 'x'
	}
	data, _ := json.Marshal(map[string]string{"type": msgType, "padding": string(padding)})
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
// checkPageSeal / derivePageBreaks Tests
// =============================================================================

func TestCheckPageSeal_CountThreshold(t *testing.T) {
	s := createTestSession()

	// Append DefaultPageSize messages (user/assistant pairs).
	for i := 0; i < DefaultPageSize; i++ {
		msg := makeMsg("user")
		s.rawMessages = append(s.rawMessages, msg)
		s.currentPageCount++
		s.currentPageBytes += len(msg)
		s.checkPageSeal()
	}

	if len(s.pageBreaks) != 1 {
		t.Fatalf("expected 1 page break after %d messages, got %d", DefaultPageSize, len(s.pageBreaks))
	}
	if s.currentPageCount != 0 {
		t.Errorf("expected currentPageCount reset to 0, got %d", s.currentPageCount)
	}
	if s.currentPageBytes != 0 {
		t.Errorf("expected currentPageBytes reset to 0, got %d", s.currentPageBytes)
	}
}

func TestCheckPageSeal_BytesThreshold(t *testing.T) {
	s := createTestSession()

	// Append a few large messages that exceed DefaultPageBytes before DefaultPageSize.
	msgSize := 200 * 1024 // 200 KB each
	for i := 0; i < 3; i++ {
		msg := makeLargeMsg("user", msgSize)
		s.rawMessages = append(s.rawMessages, msg)
		s.currentPageCount++
		s.currentPageBytes += len(msg)
		s.checkPageSeal()
	}

	// 3 * 200KB = 600KB > 500KB → should have sealed
	if len(s.pageBreaks) != 1 {
		t.Fatalf("expected 1 page break from byte threshold (3 msgs × %d bytes), got %d page breaks", msgSize, len(s.pageBreaks))
	}
	if s.currentPageCount != 0 {
		t.Errorf("expected currentPageCount reset to 0, got %d", s.currentPageCount)
	}
	if s.currentPageBytes != 0 {
		t.Errorf("expected currentPageBytes reset to 0, got %d", s.currentPageBytes)
	}
}

func TestCheckPageSeal_BytesThreshold_BeforeCount(t *testing.T) {
	// Ensure size seals the page even when count is well below DefaultPageSize.
	s := createTestSession()

	msg := makeLargeMsg("user", DefaultPageBytes+1)
	s.rawMessages = append(s.rawMessages, msg)
	s.currentPageCount++
	s.currentPageBytes += len(msg)
	s.checkPageSeal()

	if len(s.pageBreaks) != 1 {
		t.Fatalf("expected seal from single large message exceeding byte limit, got %d page breaks", len(s.pageBreaks))
	}
	if s.currentPageCount != 0 {
		t.Errorf("expected currentPageCount reset to 0, got %d", s.currentPageCount)
	}
}

func TestCheckPageSeal_BlockedByOpenStream(t *testing.T) {
	s := createTestSession()

	// Exceed both thresholds but with an open stream.
	msg := makeLargeMsg("user", DefaultPageBytes+1)
	s.rawMessages = append(s.rawMessages, msg)
	s.currentPageCount = DefaultPageSize + 1
	s.currentPageBytes = len(msg)
	s.hasOpenStream = true
	s.checkPageSeal()

	if len(s.pageBreaks) != 0 {
		t.Fatal("expected no seal while hasOpenStream is true")
	}

	// Close the stream → should seal.
	s.hasOpenStream = false
	s.checkPageSeal()

	if len(s.pageBreaks) != 1 {
		t.Fatal("expected seal after stream closed")
	}
}

func TestDerivePageBreaks_SizeBasedSealing(t *testing.T) {
	s := createTestSession()

	// Build a message list: 3 large messages (200KB each) then 2 small messages.
	// First 3 should form a sealed page (600KB > 500KB), remaining 2 are open page.
	msgSize := 200 * 1024
	for i := 0; i < 3; i++ {
		s.rawMessages = append(s.rawMessages, makeLargeMsg("user", msgSize))
	}
	s.rawMessages = append(s.rawMessages, makeMsg("user"))
	s.rawMessages = append(s.rawMessages, makeMsg("assistant"))

	s.derivePageBreaks()

	if len(s.pageBreaks) != 1 {
		t.Fatalf("expected 1 page break, got %d", len(s.pageBreaks))
	}
	if s.pageBreaks[0] != 3 {
		t.Errorf("expected page break at index 3, got %d", s.pageBreaks[0])
	}
	if s.currentPageCount != 2 {
		t.Errorf("expected 2 messages in open page, got %d", s.currentPageCount)
	}
}

func TestDerivePageBreaks_StreamEventsCountTowardBytes(t *testing.T) {
	// stream_events don't count toward message count but DO contribute bytes.
	// This tests that large stream_events push toward the byte threshold,
	// and the page seals once the stream is closed.
	s := createTestSession()

	// Add large stream events + assistant that closes them, exceeding byte limit.
	s.rawMessages = append(s.rawMessages, makeLargeMsg("stream_event", 300*1024))
	s.rawMessages = append(s.rawMessages, makeLargeMsg("stream_event", 300*1024))
	s.rawMessages = append(s.rawMessages, makeMsg("assistant")) // closes stream, count=1

	// Add a trailing message so we can verify the page split.
	s.rawMessages = append(s.rawMessages, makeMsg("user"))

	s.derivePageBreaks()

	// 600KB from stream events + small assistant > 500KB, and count=1 (assistant).
	// Should seal after assistant since stream is closed and bytes exceeded.
	if len(s.pageBreaks) != 1 {
		t.Fatalf("expected 1 page break (bytes from stream_events), got %d", len(s.pageBreaks))
	}
	if s.pageBreaks[0] != 3 {
		t.Errorf("expected page break at index 3, got %d", s.pageBreaks[0])
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
