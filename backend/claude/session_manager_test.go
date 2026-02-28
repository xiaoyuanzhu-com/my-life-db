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

func TestConcurrent_ListAllSessions(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	// Add sessions directly (one store)
	m.mu.Lock()
	m.initialized = true
	for i := 0; i < 50; i++ {
		id := "session-" + string(rune('a'+(i%26))) + string(rune('0'+(i/26)))
		m.sessions[id] = &Session{
			ID:           id,
			Title: "Test Session",
			MessageCount: i + 1,
			LastActivity: time.Now().Add(time.Duration(-i) * time.Minute),
			Status:       "active",
			Clients:      make(map[*Client]bool),
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

	// Add 25 sessions
	m.mu.Lock()
	m.initialized = true
	baseTime := time.Now()
	for i := 0; i < 25; i++ {
		id := "session-" + string(rune('a'+i))
		m.sessions[id] = &Session{
			ID:               id,
			Title:     "Test Session " + string(rune('A'+i)),
			MessageCount:     i + 1,
			LastActivity:     baseTime.Add(time.Duration(-i) * time.Minute),
			LastUserActivity: baseTime.Add(time.Duration(-i) * time.Minute),
			Status:           "active",
			Clients:          make(map[*Client]bool),
		}
	}
	m.mu.Unlock()

	// First page
	result := m.ListAllSessions("", 10, "")
	if len(result.Sessions) != 10 {
		t.Errorf("expected 10 sessions, got %d", len(result.Sessions))
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
	if len(result2.Sessions) != 10 {
		t.Errorf("expected 10 sessions, got %d", len(result2.Sessions))
	}
	if !result2.HasMore {
		t.Error("expected HasMore to be true")
	}

	// Third page (last)
	result3 := m.ListAllSessions(result2.NextCursor, 10, "")
	if len(result3.Sessions) != 5 {
		t.Errorf("expected 5 sessions, got %d", len(result3.Sessions))
	}
	if result3.HasMore {
		t.Error("expected HasMore to be false")
	}

	// Verify no duplicates across pages
	seen := make(map[string]bool)
	allSessions := append(result.Sessions, result2.Sessions...)
	allSessions = append(allSessions, result3.Sessions...)
	for _, s := range allSessions {
		if seen[s.ID] {
			t.Errorf("duplicate session ID: %s", s.ID)
		}
		seen[s.ID] = true
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
		m.sessions[id] = &Session{
			ID:           id,
			Title: "Test",
			MessageCount: 1,
			LastActivity: time.Now(),
			Status:       "active",
			Clients:      make(map[*Client]bool),
		}
	}
	m.mu.Unlock()

	// Test limit 0 -> defaults to 20
	result := m.ListAllSessions("", 0, "")
	if len(result.Sessions) != 20 {
		t.Errorf("expected default limit of 20, got %d", len(result.Sessions))
	}

	// Test limit > 100 -> capped to 100
	result = m.ListAllSessions("", 200, "")
	if len(result.Sessions) != 100 {
		t.Errorf("expected max limit of 100, got %d", len(result.Sessions))
	}

	// Test negative limit -> defaults to 20
	result = m.ListAllSessions("", -5, "")
	if len(result.Sessions) != 20 {
		t.Errorf("expected default limit of 20 for negative, got %d", len(result.Sessions))
	}
}

func TestListAllSessions_StatusFilter(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	m.mu.Lock()
	m.initialized = true

	// Add sessions that will be "archived" (IsArchived is set per-query from DB,
	// but for testing we set it directly since tests don't have a real DB)
	for i := 0; i < 5; i++ {
		id := "archived-" + string(rune('a'+i))
		m.sessions[id] = &Session{
			ID:           id,
			Title: "Archived",
			MessageCount: 1,
			LastActivity: time.Now(),
			Status:       "active",
			Clients:      make(map[*Client]bool),
			IsArchived:   true,
		}
	}

	// Add active sessions
	for i := 0; i < 3; i++ {
		id := "active-" + string(rune('a'+i))
		m.sessions[id] = &Session{
			ID:           id,
			Title: "Active",
			MessageCount: 1,
			LastActivity: time.Now(),
			Status:       "active",
			Clients:      make(map[*Client]bool),
			activated:    true,
		}
	}
	m.mu.Unlock()

	// Filter active only (non-archived)
	result := m.ListAllSessions("", 20, "active")
	if len(result.Sessions) != 3 {
		t.Errorf("expected 3 active sessions, got %d", len(result.Sessions))
	}
	for _, s := range result.Sessions {
		if s.IsArchived {
			t.Errorf("expected non-archived, got archived for %s", s.ID)
		}
	}

	// Filter archived only
	result = m.ListAllSessions("", 20, "archived")
	if len(result.Sessions) != 5 {
		t.Errorf("expected 5 archived sessions, got %d", len(result.Sessions))
	}
	for _, s := range result.Sessions {
		if !s.IsArchived {
			t.Errorf("expected archived, got non-archived for %s", s.ID)
		}
	}
}

func TestListAllSessions_SortsByModifiedDescending(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	baseTime := time.Now()
	m.mu.Lock()
	m.initialized = true
	m.sessions["oldest"] = &Session{
		ID:               "oldest",
		Title:     "Oldest",
		MessageCount:     1,
		LastActivity:     baseTime.Add(-3 * time.Hour),
		LastUserActivity: baseTime.Add(-3 * time.Hour),
		Status:           "active",
		Clients:          make(map[*Client]bool),
	}
	m.sessions["middle"] = &Session{
		ID:               "middle",
		Title:     "Middle",
		MessageCount:     1,
		LastActivity:     baseTime.Add(-1 * time.Hour),
		LastUserActivity: baseTime.Add(-1 * time.Hour),
		Status:           "active",
		Clients:          make(map[*Client]bool),
	}
	m.sessions["newest"] = &Session{
		ID:               "newest",
		Title:     "Newest",
		MessageCount:     1,
		LastActivity:     baseTime,
		LastUserActivity: baseTime,
		Status:           "active",
		Clients:          make(map[*Client]bool),
	}
	m.mu.Unlock()

	result := m.ListAllSessions("", 10, "")
	if len(result.Sessions) != 3 {
		t.Fatalf("expected 3 sessions, got %d", len(result.Sessions))
	}

	if result.Sessions[0].ID != "newest" {
		t.Errorf("expected first session to be newest, got %s", result.Sessions[0].ID)
	}
	if result.Sessions[1].ID != "middle" {
		t.Errorf("expected second session to be middle, got %s", result.Sessions[1].ID)
	}
	if result.Sessions[2].ID != "oldest" {
		t.Errorf("expected third session to be oldest, got %s", result.Sessions[2].ID)
	}
}

func TestListAllSessions_DeduplicatesByFirstUserMessageUUID(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	m.mu.Lock()
	m.initialized = true

	// Two sessions with same FirstUserMessageUUID (keep the one with more messages)
	m.sessions["session-1"] = &Session{
		ID:                   "session-1",
		Title:         "Session 1",
		FirstUserMessageUUID: "same-uuid",
		MessageCount:         5,
		LastActivity:         time.Now(),
		LastUserActivity:     time.Now(),
		Status:               "active",
		Clients:              make(map[*Client]bool),
	}
	m.sessions["session-2"] = &Session{
		ID:                   "session-2",
		Title:         "Session 2",
		FirstUserMessageUUID: "same-uuid",
		MessageCount:         10, // More messages
		LastActivity:         time.Now(),
		LastUserActivity:     time.Now(),
		Status:               "active",
		Clients:              make(map[*Client]bool),
	}
	// A unique session
	m.sessions["session-3"] = &Session{
		ID:                   "session-3",
		Title:         "Session 3",
		FirstUserMessageUUID: "unique-uuid",
		MessageCount:         3,
		LastActivity:         time.Now(),
		LastUserActivity:     time.Now(),
		Status:               "active",
		Clients:              make(map[*Client]bool),
	}
	m.mu.Unlock()

	result := m.ListAllSessions("", 10, "")

	// Should have 2 sessions (one from deduplicated pair, one unique)
	if len(result.Sessions) != 2 {
		t.Errorf("expected 2 sessions after dedup, got %d", len(result.Sessions))
	}

	// The deduplicated session should be session-2 (more messages)
	found := false
	for _, s := range result.Sessions {
		if s.ID == "session-2" {
			found = true
		}
		if s.ID == "session-1" {
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
	m.sessions["empty-untitled"] = &Session{
		ID:           "empty-untitled",
		Title: "Untitled",
		MessageCount: 0,
		LastActivity: time.Now(),
		Status:       "active",
		Clients:      make(map[*Client]bool),
	}
	m.sessions["empty-titled"] = &Session{
		ID:           "empty-titled",
		Title: "Session 10",
		MessageCount: 0,
		LastActivity: time.Now(),
		Status:       "active",
		Clients:      make(map[*Client]bool),
	}
	m.sessions["has-content"] = &Session{
		ID:               "has-content",
		Title:     "Has Content",
		MessageCount:     5,
		LastActivity:     time.Now(),
		LastUserActivity: time.Now(),
		Status:           "active",
		Clients:          make(map[*Client]bool),
	}
	m.mu.Unlock()

	result := m.ListAllSessions("", 10, "")
	if len(result.Sessions) != 1 {
		t.Errorf("expected 1 session (both empty sessions skipped), got %d", len(result.Sessions))
	}
	if result.Sessions[0].ID != "has-content" {
		t.Errorf("expected has-content, got %s", result.Sessions[0].ID)
	}
}

func TestListAllSessions_InvalidCursor(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	m.mu.Lock()
	m.initialized = true
	for i := 0; i < 5; i++ {
		id := "session-" + string(rune('a'+i))
		m.sessions[id] = &Session{
			ID:               id,
			Title:     "Test",
			MessageCount:     1,
			LastActivity:     time.Now(),
			LastUserActivity: time.Now(),
			Status:           "active",
			Clients:          make(map[*Client]bool),
		}
	}
	m.mu.Unlock()

	// Invalid cursor should start from beginning
	result := m.ListAllSessions("invalid-cursor", 10, "")
	if len(result.Sessions) != 5 {
		t.Errorf("expected 5 sessions with invalid cursor, got %d", len(result.Sessions))
	}
}

// =============================================================================
// IsWorking Tests
// =============================================================================

func TestSession_IsWorking(t *testing.T) {
	tests := []struct {
		name                   string
		isProcessing           bool
		pendingPermissionCount int
		want                   bool
	}{
		{"idle session", false, 0, false},
		{"processing no permissions", true, 0, true},
		{"processing with pending permission", true, 1, false},
		{"not processing with stale permission", false, 1, false},
		{"processing with multiple permissions", true, 3, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &Session{
				isProcessing:           tt.isProcessing,
				pendingPermissionCount: tt.pendingPermissionCount,
			}
			if got := s.IsWorking(); got != tt.want {
				t.Errorf("IsWorking() = %v, want %v", got, tt.want)
			}
		})
	}
}

// =============================================================================
// Working Session Count Tests
// =============================================================================

func TestSessionManager_WorkingSessionCount(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	m.mu.Lock()
	m.initialized = true

	// Idle session
	m.sessions["idle"] = &Session{
		ID:           "idle",
		Clients:      make(map[*Client]bool),
		isProcessing: false,
	}

	// Working session (processing, no pending permissions)
	m.sessions["working"] = &Session{
		ID:           "working",
		Clients:      make(map[*Client]bool),
		isProcessing: true,
	}

	// Permission-blocked session (processing but waiting on permission)
	m.sessions["permission"] = &Session{
		ID:                     "permission",
		Clients:                make(map[*Client]bool),
		isProcessing:           true,
		pendingPermissionCount: 1,
	}
	m.mu.Unlock()

	ids, count := m.workingSessionIDs()
	if count != 1 {
		t.Errorf("expected 1 working session, got %d", count)
	}
	if len(ids) != 1 || ids[0] != "working" {
		t.Errorf("expected [working], got %v", ids)
	}
}

func TestSessionManager_WorkingSessionCount_NoneWorking(t *testing.T) {
	m, cleanup := createTestManager(t)
	defer cleanup()

	m.mu.Lock()
	m.initialized = true
	m.sessions["idle1"] = &Session{
		ID:           "idle1",
		Clients:      make(map[*Client]bool),
		isProcessing: false,
	}
	m.sessions["idle2"] = &Session{
		ID:           "idle2",
		Clients:      make(map[*Client]bool),
		isProcessing: false,
	}
	m.mu.Unlock()

	_, count := m.workingSessionIDs()
	if count != 0 {
		t.Errorf("expected 0 working sessions, got %d", count)
	}
}

// =============================================================================
// Drain-Then-Shutdown Tests
// =============================================================================

func TestDrainAndShutdown_NoWorkingSessions(t *testing.T) {
	m, _ := createTestManager(t) // Don't defer cleanup — we call Shutdown manually

	m.mu.Lock()
	m.initialized = true
	m.sessions["idle"] = &Session{
		ID:           "idle",
		Clients:      make(map[*Client]bool),
		isProcessing: false,
	}
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	start := time.Now()
	err := m.Shutdown(ctx)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("Shutdown returned error: %v", err)
	}

	// Should complete after ~5s settle (no drain wait)
	if elapsed > 8*time.Second {
		t.Errorf("Shutdown took too long: %v (expected ~5s settle)", elapsed)
	}
	if elapsed < 4*time.Second {
		t.Errorf("Shutdown too fast: %v (expected ~5s settle)", elapsed)
	}
}

func TestDrainAndShutdown_WaitsForWorkingSessions(t *testing.T) {
	m, _ := createTestManager(t)

	m.mu.Lock()
	m.initialized = true

	workingSession := &Session{
		ID:           "working",
		Clients:      make(map[*Client]bool),
		isProcessing: true,
		onStateChanged: func() {
			m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: "working"})
		},
	}
	m.sessions["working"] = workingSession
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	shutdownDone := make(chan error, 1)
	go func() {
		shutdownDone <- m.Shutdown(ctx)
	}()

	// Simulate session finishing after 500ms
	time.Sleep(500 * time.Millisecond)
	workingSession.mu.Lock()
	workingSession.isProcessing = false
	workingSession.mu.Unlock()
	// Trigger the state change notification via the manager (simulating what onStateChanged does)
	m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: "working"})

	select {
	case err := <-shutdownDone:
		if err != nil {
			t.Fatalf("Shutdown returned error: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Shutdown did not complete after session finished")
	}
}

func TestDrainAndShutdown_PermissionBlockedDoesNotBlock(t *testing.T) {
	m, _ := createTestManager(t)

	m.mu.Lock()
	m.initialized = true
	m.sessions["permission-blocked"] = &Session{
		ID:                     "permission-blocked",
		Clients:                make(map[*Client]bool),
		isProcessing:           true,
		pendingPermissionCount: 1,
	}
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	start := time.Now()
	err := m.Shutdown(ctx)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("Shutdown returned error: %v", err)
	}

	// Should not wait for permission-blocked session — just settle
	if elapsed > 8*time.Second {
		t.Errorf("Shutdown took too long: %v (permission-blocked should not block drain)", elapsed)
	}
}

func TestDrainAndShutdown_Timeout(t *testing.T) {
	m, _ := createTestManager(t)

	m.mu.Lock()
	m.initialized = true
	m.sessions["stuck"] = &Session{
		ID:           "stuck",
		Clients:      make(map[*Client]bool),
		isProcessing: true, // Never finishes
	}
	m.mu.Unlock()

	// Short timeout to speed up test
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	start := time.Now()
	err := m.Shutdown(ctx)
	elapsed := time.Since(start)

	// Should timeout, not error (context deadline drives the timeout)
	if err != nil {
		t.Fatalf("Shutdown returned error: %v", err)
	}

	// Should have waited roughly 2s (the timeout), not longer
	if elapsed > 4*time.Second {
		t.Errorf("Shutdown took too long after timeout: %v", elapsed)
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

func createTestManager(t *testing.T) (*SessionManager, func()) {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())

	m := &SessionManager{
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
