# Drain-Then-Shutdown Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wait for active Claude sessions to finish their current turn before shutting down the server, so deployments never interrupt mid-work sessions.

**Architecture:** Reorder the existing shutdown sequence: close HTTP listener first (blocks new requests), then drain active Claude sessions (wait up to 10 min for all "working" sessions to reach idle), then clean up. "Working" = `isProcessing && pendingPermissionCount == 0`. Sessions blocked on permission don't count — they need human input to progress.

**Tech Stack:** Go, existing `SessionManager`/`Session` types, `onStateChanged` callback, `http.Server.Shutdown()`

---

### Task 1: Add `IsWorking()` helper to Session

**Files:**
- Modify: `backend/claude/session.go` (after `Snapshot()` method, ~line 186)
- Test: `backend/claude/session_manager_test.go`

**Step 1: Write the failing test**

Add to the bottom of `backend/claude/session_manager_test.go`, before the helper functions section:

```go
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
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test ./claude/ -run TestSession_IsWorking -v`
Expected: FAIL — `s.IsWorking undefined`

**Step 3: Write minimal implementation**

Add to `backend/claude/session.go` after the `Snapshot()` method (~line 186):

```go
// IsWorking returns true if the session is actively processing (mid-turn)
// and NOT blocked waiting for user permission. Sessions waiting on permission
// will not progress without human input and should not block server shutdown.
func (s *Session) IsWorking() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.isProcessing && s.pendingPermissionCount == 0
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && go test ./claude/ -run TestSession_IsWorking -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/claude/session.go backend/claude/session_manager_test.go
git commit -m "feat: add Session.IsWorking() helper for drain-then-shutdown"
```

---

### Task 2: Add `workingSessionCount()` to SessionManager

**Files:**
- Modify: `backend/claude/session_manager.go` (after `SignalShutdown()`, ~line 213)
- Test: `backend/claude/session_manager_test.go`

**Step 1: Write the failing test**

Add to `backend/claude/session_manager_test.go`:

```go
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
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test ./claude/ -run TestSessionManager_WorkingSessionCount -v`
Expected: FAIL — `m.workingSessionIDs undefined`

**Step 3: Write minimal implementation**

Add to `backend/claude/session_manager.go` after `SignalShutdown()` (~line 213):

```go
// workingSessionIDs returns the IDs and count of sessions currently in "working" state
// (actively processing, not blocked on permission). Used by drain logic.
func (m *SessionManager) workingSessionIDs() ([]string, int) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var ids []string
	for id, session := range m.sessions {
		if session.IsWorking() {
			ids = append(ids, id)
		}
	}
	return ids, len(ids)
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && go test ./claude/ -run TestSessionManager_WorkingSessionCount -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/claude/session_manager.go backend/claude/session_manager_test.go
git commit -m "feat: add workingSessionIDs() for drain-then-shutdown"
```

---

### Task 3: Implement `DrainAndShutdown()` on SessionManager

This is the core change. Replace the aggressive 2s-wait-then-force-kill in `Shutdown()` with a patient drain that waits for all working sessions to finish.

**Files:**
- Modify: `backend/claude/session_manager.go` — replace `Shutdown()` body
- Test: `backend/claude/session_manager_test.go`

**Step 1: Write the failing tests**

Add to `backend/claude/session_manager_test.go`:

```go
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

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	start := time.Now()
	err := m.Shutdown(ctx)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("Shutdown returned error: %v", err)
	}

	// Should complete quickly (no drain wait) + 5s settle
	// Allow some slack for CI but should be well under 10s
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

	stateChanged := make(chan struct{}, 10)
	workingSession := &Session{
		ID:           "working",
		Clients:      make(map[*Client]bool),
		isProcessing: true,
		onStateChanged: func() {
			select {
			case stateChanged <- struct{}{}:
			default:
			}
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
	cb := workingSession.onStateChanged
	workingSession.mu.Unlock()
	if cb != nil {
		cb()
	}

	select {
	case err := <-shutdownDone:
		if err != nil {
			t.Fatalf("Shutdown returned error: %v", err)
		}
	case <-time.After(10 * time.Second):
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
```

**Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./claude/ -run TestDrainAndShutdown -v -timeout 60s`
Expected: Some tests FAIL — current `Shutdown()` doesn't have drain logic or 5s settle.

**Step 3: Rewrite `Shutdown()` with drain logic**

Replace the entire `Shutdown()` method in `backend/claude/session_manager.go` (lines 215-279):

```go
// Shutdown gracefully stops the session manager.
// It drains active sessions (waits for "working" sessions to finish their current turn),
// then settles for 5 seconds, and finally cleans up resources.
// The ctx deadline controls the maximum wait time for draining.
func (m *SessionManager) Shutdown(ctx context.Context) error {
	log.Info().Msg("shutting down SessionManager")

	// Close FS watcher early — no new session discovery during drain
	if m.watcher != nil {
		m.watcher.Close()
	}

	// ── Drain: wait for working sessions to finish ──

	// Subscribe to state changes so we wake up when sessions finish
	drainNotify := make(chan struct{}, 100)
	unsubscribe := m.Subscribe(func(event SessionEvent) {
		select {
		case drainNotify <- struct{}{}:
		default:
		}
	})

	ids, count := m.workingSessionIDs()
	if count > 0 {
		log.Info().Int("workingSessions", count).Strs("sessionIDs", ids).Msg("draining: waiting for working sessions to finish")

	drainLoop:
		for {
			select {
			case <-drainNotify:
				ids, count = m.workingSessionIDs()
				if count == 0 {
					log.Info().Msg("drain complete: all sessions finished")
					break drainLoop
				}
				log.Info().Int("remaining", count).Strs("sessionIDs", ids).Msg("draining: sessions still working")
			case <-ctx.Done():
				ids, count = m.workingSessionIDs()
				log.Warn().Int("remaining", count).Strs("sessionIDs", ids).Msg("drain timeout: force killing remaining sessions")
				m.forceKillAllSessions()
				break drainLoop
			}
		}
	} else {
		log.Info().Msg("no working sessions, skipping drain")
	}

	unsubscribe()

	// ── Settle: wait 5s for final writes to flush ──

	settleTimer := time.NewTimer(5 * time.Second)
	select {
	case <-settleTimer.C:
		log.Info().Msg("settle complete")
	case <-ctx.Done():
		settleTimer.Stop()
		log.Warn().Msg("settle interrupted by context timeout")
	}

	// ── Cleanup ──

	// Signal goroutines to stop
	m.cancel()

	// Force kill any remaining live processes (permission-blocked, etc.)
	liveCount := atomic.LoadInt32(&m.liveProcessCount)
	if liveCount > 0 {
		log.Info().Int32("liveProcesses", liveCount).Msg("killing remaining live processes after drain")
		m.forceKillAllSessions()

		// Brief wait for processes to exit
		waitCtx, waitCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer waitCancel()

	waitLoop:
		for atomic.LoadInt32(&m.liveProcessCount) > 0 {
			select {
			case <-m.processExited:
				continue
			case <-waitCtx.Done():
				remaining := atomic.LoadInt32(&m.liveProcessCount)
				if remaining > 0 {
					log.Warn().Int32("remaining", remaining).Msg("some processes did not exit after force kill")
				}
				break waitLoop
			}
		}
	}

	// Clean up session map
	m.mu.Lock()
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	// Close all subscriber channels
	m.subscribersMu.Lock()
	for ch := range m.subscribers {
		close(ch)
	}
	m.subscribers = make(map[chan SessionEvent]struct{})
	m.subscribersMu.Unlock()

	// Wait for internal goroutines
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		log.Info().Msg("SessionManager shutdown complete")
		return nil
	case <-time.After(2 * time.Second):
		log.Warn().Msg("SessionManager goroutine cleanup timed out")
		return nil
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./claude/ -run TestDrainAndShutdown -v -timeout 120s`
Expected: ALL PASS

**Step 5: Run all existing session manager tests to check for regressions**

Run: `cd backend && go test ./claude/ -v -timeout 120s`
Expected: ALL PASS (existing tests should still work — `createTestManager` calls `Shutdown()` in its cleanup function)

**Step 6: Commit**

```bash
git add backend/claude/session_manager.go backend/claude/session_manager_test.go
git commit -m "feat: drain-then-shutdown in SessionManager

Wait for actively working Claude sessions to finish their current turn
before shutting down, instead of force-killing after 2 seconds.
Sessions blocked on permission do not block the drain.
After drain completes, settle for 5 seconds before cleanup."
```

---

### Task 4: Reorder `Server.Shutdown()` — HTTP first

**Files:**
- Modify: `backend/server/server.go` — reorder the `Shutdown()` method

**Step 1: Rewrite `Server.Shutdown()`**

Replace the `Shutdown()` method in `backend/server/server.go` (lines 331-383):

```go
// Shutdown gracefully shuts down the server using drain-then-shutdown.
// Sequence: close HTTP listener → signal sessions → close WS/SSE → drain active sessions → cleanup.
func (s *Server) Shutdown(ctx context.Context) error {
	log.Info().Msg("shutting down server")

	// 1. Stop accepting new HTTP connections FIRST.
	// WebSocket connections are hijacked and not tracked by http.Server,
	// so this returns quickly. Clients get connection refused and use
	// their reconnect logic to reach the new server after restart.
	if s.http != nil {
		// Short timeout for closing listener + finishing in-flight HTTP (not WS)
		httpCtx, httpCancel := context.WithTimeout(ctx, 5*time.Second)
		defer httpCancel()
		if err := s.http.Shutdown(httpCtx); err != nil {
			log.Error().Err(err).Msg("http server shutdown error")
		}
		log.Info().Msg("HTTP listener closed")
	}

	// 2. Signal Claude sessions that we're shutting down.
	// This must happen before SIGINT propagates to child processes,
	// so they know to expect process exit errors and log at debug level.
	if s.claudeManager != nil {
		s.claudeManager.SignalShutdown()
	}

	// 3. Cancel the shutdown context to signal all long-running handlers (WebSocket, SSE)
	log.Info().Msg("signaling handlers to stop")
	s.shutdownCancel()

	// Give handlers a moment to process the cancellation and close connections.
	time.Sleep(100 * time.Millisecond)

	// 4. Close notification service to cleanly disconnect SSE clients
	s.notifService.Shutdown()

	// 5. Drain active Claude sessions (waits for "working" sessions to finish)
	if s.claudeManager != nil {
		if err := s.claudeManager.Shutdown(ctx); err != nil {
			log.Error().Err(err).Msg("Claude manager shutdown error")
		}
	}

	// 6. Stop background services (in reverse order of startup)
	s.meiliSyncWorker.Stop()
	s.digestWorker.Stop()
	s.fsService.Stop()

	// 7. Close database last
	if s.database != nil {
		if err := s.database.Close(); err != nil {
			log.Error().Err(err).Msg("database close error")
			return err
		}
	}

	log.Info().Msg("server shutdown complete")
	return nil
}
```

**Step 2: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add backend/server/server.go
git commit -m "feat: reorder server shutdown — HTTP listener closes first

Close the HTTP listener before draining Claude sessions so clients
get connection refused immediately and use reconnect logic to reach
the new server after restart."
```

---

### Task 5: Increase shutdown timeout in `main.go`

**Files:**
- Modify: `backend/main.go` — line 86

**Step 1: Change the timeout**

In `backend/main.go`, change line 86 from:

```go
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
```

to:

```go
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute+5*time.Second)
```

**Step 2: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add backend/main.go
git commit -m "feat: increase shutdown timeout to 10m5s for drain-then-shutdown

10 minutes drain + 5 seconds settle buffer. The previous 15-second
timeout was too aggressive for waiting on active Claude sessions."
```

---

### Task 6: Add `stop_grace_period` to Docker Compose in README

**Files:**
- Modify: `README.md` — Docker Compose example (~lines 24-38)

**Step 1: Add stop_grace_period to the Docker Compose example**

In `README.md`, update the Docker Compose example (after the `restart: unless-stopped` line, ~line 34) to include:

```yaml
    stop_grace_period: 11m
```

The full services block should become:

```yaml
services:
  mylifedb:
    image: ghcr.io/xiaoyuanzhu-com/my-life-db:latest
    container_name: mylifedb
    ports:
      - 12345:12345
    volumes:
      - ./data:/home/xiaoyuanzhu/my-life-db/data
      - ./app-data:/home/xiaoyuanzhu/my-life-db/.my-life-db
    restart: unless-stopped
    stop_grace_period: 11m
    environment:
      - USER_DATA_DIR=/home/xiaoyuanzhu/my-life-db/data
      - APP_DATA_DIR=/home/xiaoyuanzhu/my-life-db/.my-life-db
```

Note: 11 minutes (slightly longer than the 10m5s internal timeout) so the Go process always completes cleanup before Docker sends SIGKILL.

**Step 2: Commit**

```bash
git add README.md
git commit -m "feat: add stop_grace_period to Docker Compose example

11 minutes gives the server enough time to drain active Claude sessions
(10 min) plus settle (5s) before Docker sends SIGKILL."
```

---

### Task 7: Run full test suite and verify

**Step 1: Run all backend tests**

Run: `cd backend && go test ./... -timeout 120s`
Expected: ALL PASS

**Step 2: Build the binary**

Run: `cd backend && go build -o /dev/null ./...`
Expected: Build succeeds
