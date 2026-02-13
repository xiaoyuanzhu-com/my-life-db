package claude

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// =============================================================================
// Subscription Tests
// =============================================================================

func TestSubscribe_ReceivesEvents(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	received := make(chan SessionEvent, 10)
	unsubscribe := m.Subscribe(func(event SessionEvent) {
		received <- event
	})
	defer unsubscribe()

	// Emit an event
	m.notify(SessionEvent{Type: SessionEventCreated, SessionID: "test-session-1"})

	select {
	case event := <-received:
		if event.Type != SessionEventCreated {
			t.Errorf("expected event type %s, got %s", SessionEventCreated, event.Type)
		}
		if event.SessionID != "test-session-1" {
			t.Errorf("expected session ID test-session-1, got %s", event.SessionID)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for event")
	}
}

func TestSubscribe_Unsubscribe(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	received := make(chan SessionEvent, 10)
	unsubscribe := m.Subscribe(func(event SessionEvent) {
		received <- event
	})

	// Unsubscribe
	unsubscribe()

	// Emit an event after unsubscribe
	m.notify(SessionEvent{Type: SessionEventCreated, SessionID: "test-session-1"})

	// Should not receive the event
	select {
	case <-received:
		t.Fatal("received event after unsubscribe")
	case <-time.After(50 * time.Millisecond):
		// Expected: no event received
	}
}

func TestSubscribe_MultipleSubscribers(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	const numSubscribers = 5
	received := make([]chan SessionEvent, numSubscribers)
	unsubscribes := make([]func(), numSubscribers)

	for i := 0; i < numSubscribers; i++ {
		received[i] = make(chan SessionEvent, 10)
		idx := i
		unsubscribes[i] = m.Subscribe(func(event SessionEvent) {
			received[idx] <- event
		})
	}
	defer func() {
		for _, unsub := range unsubscribes {
			unsub()
		}
	}()

	// Emit an event
	m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: "test-session-1"})

	// All subscribers should receive the event
	for i := 0; i < numSubscribers; i++ {
		select {
		case event := <-received[i]:
			if event.Type != SessionEventUpdated {
				t.Errorf("subscriber %d: expected event type %s, got %s", i, SessionEventUpdated, event.Type)
			}
		case <-time.After(100 * time.Millisecond):
			t.Errorf("subscriber %d: timeout waiting for event", i)
		}
	}
}

func TestSubscribe_DoubleUnsubscribe(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	unsubscribe := m.Subscribe(func(event SessionEvent) {})

	// Double unsubscribe should not panic
	unsubscribe()
	unsubscribe()
}

func TestSubscribe_ShutdownCleansUp(t *testing.T) {
	m, cleanup := createTestManager(t)

	callbackCalled := make(chan struct{})
	m.Subscribe(func(event SessionEvent) {
		close(callbackCalled)
	})

	// Shutdown the manager
	cleanup()

	// The subscriber goroutine should have exited (verified by cleanup completing)
}

func TestNotify_DropsWhenChannelFull(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	// Create a subscriber with small buffer that we block
	blocking := make(chan struct{})
	m.Subscribe(func(event SessionEvent) {
		<-blocking // Block forever until we release
	})

	// Fill up the channel buffer (size is 10 in Subscribe)
	for i := 0; i < 15; i++ {
		m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: "test"})
	}

	// Should not block or panic - events are dropped
	close(blocking)
}

// =============================================================================
// Concurrency Tests
// =============================================================================

func TestConcurrent_SubscribeUnsubscribe(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	var wg sync.WaitGroup
	const numGoroutines = 50

	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			unsub := m.Subscribe(func(event SessionEvent) {})
			time.Sleep(time.Millisecond)
			unsub()
		}()
	}

	// Also emit events concurrently
	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: "test"})
		}(i)
	}

	wg.Wait()
}

func TestConcurrent_GetSessionEntry(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	// Add some entries
	m.mu.Lock()
	m.initialized = true
	for i := 0; i < 10; i++ {
		id := "session-" + string(rune('a'+i))
		m.entries[id] = &SessionEntry{
			SessionID:    id,
			DisplayTitle: "Test Session " + id,
			MessageCount: i + 1,
			Modified:     time.Now(),
		}
	}
	m.mu.Unlock()

	var wg sync.WaitGroup
	const numReaders = 100

	for i := 0; i < numReaders; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			id := "session-" + string(rune('a'+(idx%10)))
			entry := m.GetSessionEntry(id)
			if entry == nil {
				t.Errorf("expected entry for %s", id)
			}
		}(i)
	}

	wg.Wait()
}

func TestConcurrent_ListAllSessions(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	// Add entries
	m.mu.Lock()
	m.initialized = true
	for i := 0; i < 50; i++ {
		id := "session-" + string(rune('a'+(i%26))) + string(rune('0'+(i/26)))
		m.entries[id] = &SessionEntry{
			SessionID:    id,
			DisplayTitle: "Test Session",
			MessageCount: i + 1,
			Modified:     time.Now().Add(time.Duration(-i) * time.Minute),
		}
	}
	m.mu.Unlock()

	var wg sync.WaitGroup
	const numReaders = 50

	for i := 0; i < numReaders; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result := m.ListAllSessions("", 10, "")
			if result == nil {
				t.Error("expected non-nil result")
			}
		}()
	}

	wg.Wait()
}

func TestConcurrent_NotifyDuringShutdown(t *testing.T) {
	m, _ := createTestManager(t) // Don't defer cleanup, we control shutdown

	var eventCount int32
	for i := 0; i < 5; i++ {
		m.Subscribe(func(event SessionEvent) {
			atomic.AddInt32(&eventCount, 1)
		})
	}

	var wg sync.WaitGroup

	// Start emitting events
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: "test"})
			time.Sleep(time.Millisecond)
		}
	}()

	// Shutdown mid-flight
	time.Sleep(10 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	m.Shutdown(ctx)

	wg.Wait()
}

// =============================================================================
// Pagination Tests
// =============================================================================

func TestListAllSessions_Pagination(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	// Add 25 entries
	m.mu.Lock()
	m.initialized = true
	baseTime := time.Now()
	for i := 0; i < 25; i++ {
		id := "session-" + string(rune('a'+i))
		m.entries[id] = &SessionEntry{
			SessionID:    id,
			DisplayTitle: "Test Session " + string(rune('A'+i)),
			MessageCount: i + 1,
			Modified:     baseTime.Add(time.Duration(-i) * time.Minute), // Older as index increases
		}
	}
	m.mu.Unlock()

	// First page
	result := m.ListAllSessions("", 10, "")
	if len(result.Entries) != 10 {
		t.Errorf("expected 10 entries, got %d", len(result.Entries))
	}
	if !result.HasMore {
		t.Error("expected HasMore to be true")
	}
	if result.NextCursor == "" {
		t.Error("expected non-empty NextCursor")
	}
	if result.TotalCount != 25 {
		t.Errorf("expected TotalCount 25, got %d", result.TotalCount)
	}

	// Second page
	result2 := m.ListAllSessions(result.NextCursor, 10, "")
	if len(result2.Entries) != 10 {
		t.Errorf("expected 10 entries, got %d", len(result2.Entries))
	}
	if !result2.HasMore {
		t.Error("expected HasMore to be true")
	}

	// Third page (last)
	result3 := m.ListAllSessions(result2.NextCursor, 10, "")
	if len(result3.Entries) != 5 {
		t.Errorf("expected 5 entries, got %d", len(result3.Entries))
	}
	if result3.HasMore {
		t.Error("expected HasMore to be false")
	}

	// Verify no duplicates across pages
	seen := make(map[string]bool)
	allEntries := append(result.Entries, result2.Entries...)
	allEntries = append(allEntries, result3.Entries...)
	for _, entry := range allEntries {
		if seen[entry.SessionID] {
			t.Errorf("duplicate session ID: %s", entry.SessionID)
		}
		seen[entry.SessionID] = true
	}
	if len(seen) != 25 {
		t.Errorf("expected 25 unique sessions, got %d", len(seen))
	}
}

func TestListAllSessions_LimitBounds(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	m.mu.Lock()
	m.initialized = true
	for i := 0; i < 150; i++ {
		id := "session-" + string(rune('a'+(i%26))) + string(rune('0'+(i/26)%10))
		m.entries[id] = &SessionEntry{
			SessionID:    id,
			DisplayTitle: "Test",
			MessageCount: 1,
			Modified:     time.Now(),
		}
	}
	m.mu.Unlock()

	// Test limit 0 -> defaults to 20
	result := m.ListAllSessions("", 0, "")
	if len(result.Entries) != 20 {
		t.Errorf("expected default limit of 20, got %d", len(result.Entries))
	}

	// Test limit > 100 -> capped to 100
	result = m.ListAllSessions("", 200, "")
	if len(result.Entries) != 100 {
		t.Errorf("expected max limit of 100, got %d", len(result.Entries))
	}

	// Test negative limit -> defaults to 20
	result = m.ListAllSessions("", -5, "")
	if len(result.Entries) != 20 {
		t.Errorf("expected default limit of 20 for negative, got %d", len(result.Entries))
	}
}

func TestListAllSessions_StatusFilter(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	m.mu.Lock()
	m.initialized = true

	// Add archived entries
	for i := 0; i < 5; i++ {
		id := "archived-" + string(rune('a'+i))
		m.entries[id] = &SessionEntry{
			SessionID:    id,
			DisplayTitle: "Archived",
			MessageCount: 1,
			Modified:     time.Now(),
			IsActivated:  false,
		}
	}

	// Add active entries (simulated via sessions map)
	for i := 0; i < 3; i++ {
		id := "active-" + string(rune('a'+i))
		m.entries[id] = &SessionEntry{
			SessionID:    id,
			DisplayTitle: "Active",
			MessageCount: 1,
			Modified:     time.Now(),
			IsActivated:  true,
		}
		m.sessions[id] = &Session{
			ID:        id,
			Status:    "active",
			activated: true,
		}
	}
	m.mu.Unlock()

	// Filter active only (non-archived)
	result := m.ListAllSessions("", 20, "active")
	if len(result.Entries) != 3 {
		t.Errorf("expected 3 active entries, got %d", len(result.Entries))
	}
	for _, entry := range result.Entries {
		if entry.Status != "active" {
			t.Errorf("expected active status, got %s for %s", entry.Status, entry.SessionID)
		}
	}

	// Filter archived only
	result = m.ListAllSessions("", 20, "archived")
	if len(result.Entries) != 5 {
		t.Errorf("expected 5 archived entries, got %d", len(result.Entries))
	}
	for _, entry := range result.Entries {
		if entry.Status != "archived" {
			t.Errorf("expected archived status, got %s for %s", entry.Status, entry.SessionID)
		}
	}
}

func TestListAllSessions_SortsByModifiedDescending(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	baseTime := time.Now()
	m.mu.Lock()
	m.initialized = true
	m.entries["oldest"] = &SessionEntry{
		SessionID:    "oldest",
		DisplayTitle: "Oldest",
		MessageCount: 1,
		Modified:     baseTime.Add(-3 * time.Hour),
	}
	m.entries["middle"] = &SessionEntry{
		SessionID:    "middle",
		DisplayTitle: "Middle",
		MessageCount: 1,
		Modified:     baseTime.Add(-1 * time.Hour),
	}
	m.entries["newest"] = &SessionEntry{
		SessionID:    "newest",
		DisplayTitle: "Newest",
		MessageCount: 1,
		Modified:     baseTime,
	}
	m.mu.Unlock()

	result := m.ListAllSessions("", 10, "")
	if len(result.Entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(result.Entries))
	}

	if result.Entries[0].SessionID != "newest" {
		t.Errorf("expected first entry to be newest, got %s", result.Entries[0].SessionID)
	}
	if result.Entries[1].SessionID != "middle" {
		t.Errorf("expected second entry to be middle, got %s", result.Entries[1].SessionID)
	}
	if result.Entries[2].SessionID != "oldest" {
		t.Errorf("expected third entry to be oldest, got %s", result.Entries[2].SessionID)
	}
}

func TestListAllSessions_DeduplicatesByFirstUserMessageUUID(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	m.mu.Lock()
	m.initialized = true

	// Two sessions with same FirstUserMessageUUID (keep the one with more messages)
	m.entries["session-1"] = &SessionEntry{
		SessionID:            "session-1",
		DisplayTitle:         "Session 1",
		FirstUserMessageUUID: "same-uuid",
		MessageCount:         5,
		Modified:             time.Now(),
	}
	m.entries["session-2"] = &SessionEntry{
		SessionID:            "session-2",
		DisplayTitle:         "Session 2",
		FirstUserMessageUUID: "same-uuid",
		MessageCount:         10, // More messages
		Modified:             time.Now(),
	}
	// A unique session
	m.entries["session-3"] = &SessionEntry{
		SessionID:            "session-3",
		DisplayTitle:         "Session 3",
		FirstUserMessageUUID: "unique-uuid",
		MessageCount:         3,
		Modified:             time.Now(),
	}
	m.mu.Unlock()

	result := m.ListAllSessions("", 10, "")

	// Should have 2 entries (one from deduplicated pair, one unique)
	if len(result.Entries) != 2 {
		t.Errorf("expected 2 entries after dedup, got %d", len(result.Entries))
	}

	// The deduplicated entry should be session-2 (more messages)
	found := false
	for _, entry := range result.Entries {
		if entry.SessionID == "session-2" {
			found = true
		}
		if entry.SessionID == "session-1" {
			t.Error("session-1 should have been deduplicated (fewer messages)")
		}
	}
	if !found {
		t.Error("session-2 should be present (more messages)")
	}
}

func TestListAllSessions_SkipsEmptySessions(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	m.mu.Lock()
	m.initialized = true
	m.entries["empty"] = &SessionEntry{
		SessionID:    "empty",
		DisplayTitle: "Untitled",
		MessageCount: 0,
		Modified:     time.Now(),
	}
	m.entries["has-content"] = &SessionEntry{
		SessionID:    "has-content",
		DisplayTitle: "Has Content",
		MessageCount: 5,
		Modified:     time.Now(),
	}
	m.mu.Unlock()

	result := m.ListAllSessions("", 10, "")
	if len(result.Entries) != 1 {
		t.Errorf("expected 1 entry (empty skipped), got %d", len(result.Entries))
	}
	if result.Entries[0].SessionID != "has-content" {
		t.Errorf("expected has-content, got %s", result.Entries[0].SessionID)
	}
}

func TestListAllSessions_InvalidCursor(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	m.mu.Lock()
	m.initialized = true
	for i := 0; i < 5; i++ {
		id := "session-" + string(rune('a'+i))
		m.entries[id] = &SessionEntry{
			SessionID:    id,
			DisplayTitle: "Test",
			MessageCount: 1,
			Modified:     time.Now(),
		}
	}
	m.mu.Unlock()

	// Invalid cursor should start from beginning
	result := m.ListAllSessions("invalid-cursor", 10, "")
	if len(result.Entries) != 5 {
		t.Errorf("expected 5 entries with invalid cursor, got %d", len(result.Entries))
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

func createTestManager(t *testing.T) (*SessionManager, func()) {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())

	m := &SessionManager{
		entries:       make(map[string]*SessionEntry),
		sessions:      make(map[string]*Session),
		subscribers:   make(map[chan SessionEvent]struct{}),
		projectsDir:   t.TempDir(),
		ctx:           ctx,
		cancel:        cancel,
		processExited: make(chan struct{}, 100),
	}

	// Start cleanup worker
	m.wg.Add(1)
	go m.cleanupWorker()

	cleanup := func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		m.Shutdown(ctx)
	}

	return m, cleanup
}
