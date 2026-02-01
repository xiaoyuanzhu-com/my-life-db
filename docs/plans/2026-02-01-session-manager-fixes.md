# SessionManager Production Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix critical thread safety, resource leaks, and architectural issues in SessionManager; remove deprecated code.

**Architecture:** Move SessionManager from global singleton to server-owned component. Fix concurrency issues with double-checked locking. Add proper goroutine tracking for subscriptions. Remove deprecated Manager and SessionIndexCache.

**Tech Stack:** Go 1.25, sync primitives, fsnotify

---

## Task 1: Fix Lock During I/O in ensureInitialized

**Problem:** `ensureInitialized()` holds mutex during slow filesystem operations, blocking all other requests.

**Files:**
- Modify: `backend/claude/session_manager.go`

**Step 1: Implement double-checked locking pattern**

Replace the current `ensureInitialized()` with double-checked locking:

```go
// ensureInitialized lazily initializes the cache using double-checked locking
func (m *SessionManager) ensureInitialized() {
	// Fast path: already initialized (read lock only)
	m.mu.RLock()
	if m.initialized {
		m.mu.RUnlock()
		return
	}
	m.mu.RUnlock()

	// Slow path: need to initialize (write lock)
	m.mu.Lock()
	defer m.mu.Unlock()

	// Double-check after acquiring write lock
	if m.initialized {
		return
	}

	log.Info().Str("projectsDir", m.projectsDir).Msg("initializing SessionManager cache")

	m.loadFromIndexFiles()
	m.scanForMissingJSONL()

	if err := m.startWatcher(); err != nil {
		log.Error().Err(err).Msg("failed to start session watcher")
	}

	m.initialized = true

	log.Info().Int("sessionCount", len(m.entries)).Msg("SessionManager initialized")
}
```

**Step 2: Build and verify**

Run: `cd backend && go build .`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add backend/claude/session_manager.go
git commit -m "fix(claude): use double-checked locking in ensureInitialized

Prevents blocking all requests during slow filesystem initialization.
Uses read lock for fast path, only acquires write lock when needed."
```

---

## Task 2: Fix Duplicate Activation Event Emissions

**Problem:** Multiple code paths emit `SessionEventActivated`, causing duplicate events.

**Files:**
- Modify: `backend/claude/session_manager.go`

**Step 1: Remove duplicate event from activateSession**

The `activateSession` method is called from `session.activateFn` which is invoked by `EnsureActivated()`. The public `ActivateSession()` method already emits the event, so we should remove it from `activateSession()`:

Find and remove this block from `activateSession()` (around line 1185):
```go
	// Emit activation event
	m.notify(SessionEvent{Type: SessionEventActivated, SessionID: session.ID})
```

The `activateSession` function should end with just `return nil` after the process is started.

**Step 2: Verify ActivateSession still emits correctly**

Confirm that `ActivateSession()` (the public method) still has the notify call:
```go
func (m *SessionManager) ActivateSession(id string) error {
	// ... existing code ...

	// Emit event (this is the single source of activation events)
	m.notify(SessionEvent{Type: SessionEventActivated, SessionID: id})

	return nil
}
```

**Step 3: Build and verify**

Run: `cd backend && go build .`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add backend/claude/session_manager.go
git commit -m "fix(claude): remove duplicate activation event emission

activateSession() was emitting SessionEventActivated which duplicated
the event already emitted by the public ActivateSession() method.
Now only the public method emits the event."
```

---

## Task 3: Fix Memory Leak in Subscribe - Track Goroutines

**Problem:** Subscribe spawns goroutines that aren't tracked, causing leaks if unsubscribe is never called.

**Files:**
- Modify: `backend/claude/session_manager.go`

**Step 1: Add subscriber tracking with context**

Update the `Subscribe` method to track goroutines properly:

```go
// Subscribe registers a callback for session events.
// Returns an unsubscribe function. The goroutine is tracked and will be
// cleaned up on Shutdown even if unsubscribe is not called.
func (m *SessionManager) Subscribe(callback SessionEventCallback) func() {
	ch := make(chan SessionEvent, 10)

	m.subscribersMu.Lock()
	m.subscribers[ch] = struct{}{}
	m.subscribersMu.Unlock()

	// Track this goroutine in the wait group
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		for {
			select {
			case <-m.ctx.Done():
				// Manager shutting down, exit
				return
			case event, ok := <-ch:
				if !ok {
					// Channel closed by unsubscribe
					return
				}
				callback(event)
			}
		}
	}()

	// Return unsubscribe function
	return func() {
		m.subscribersMu.Lock()
		defer m.subscribersMu.Unlock()
		if _, exists := m.subscribers[ch]; exists {
			delete(m.subscribers, ch)
			close(ch)
		}
	}
}
```

**Step 2: Build and verify**

Run: `cd backend && go build .`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add backend/claude/session_manager.go
git commit -m "fix(claude): track Subscribe goroutines in wait group

Goroutines spawned by Subscribe are now tracked in wg and listen to
ctx.Done(), ensuring they are cleaned up on Shutdown even if the
caller never calls unsubscribe."
```

---

## Task 4: Improve Event Dropping Logging

**Problem:** Dropped events are logged at Warn level but should include more context.

**Files:**
- Modify: `backend/claude/session_manager.go`

**Step 1: Improve notify logging**

Update the `notify` method with better logging:

```go
// notify broadcasts an event to all subscribers
func (m *SessionManager) notify(event SessionEvent) {
	m.subscribersMu.RLock()
	defer m.subscribersMu.RUnlock()

	subscriberCount := len(m.subscribers)
	droppedCount := 0

	for ch := range m.subscribers {
		select {
		case ch <- event:
		default:
			droppedCount++
		}
	}

	if droppedCount > 0 {
		log.Warn().
			Str("sessionId", event.SessionID).
			Str("eventType", string(event.Type)).
			Int("droppedCount", droppedCount).
			Int("totalSubscribers", subscriberCount).
			Msg("dropped session events due to full subscriber channels")
	}
}
```

**Step 2: Build and verify**

Run: `cd backend && go build .`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add backend/claude/session_manager.go
git commit -m "fix(claude): improve event dropping logging with counts

Now logs how many subscribers dropped the event and total subscriber
count, making it easier to diagnose backpressure issues."
```

---

## Task 5: Move SessionManager to Server Ownership

**Problem:** SessionManager is a global singleton, violating the server-centric architecture.

**Files:**
- Modify: `backend/server/server.go`
- Modify: `backend/api/claude.go`
- Modify: `backend/api/handlers.go`
- Modify: `backend/main.go`

**Step 1: Add SessionManager to Server struct**

In `backend/server/server.go`, add the import and field:

```go
import (
	// ... existing imports ...
	"github.com/xiaoyuanzhu-com/my-life-db/claude"
)

type Server struct {
	cfg *Config

	// Components (owned by server)
	database       *db.DB
	fsService      *fs.Service
	digestWorker   *digest.Worker
	notifService   *notifications.Service
	claudeManager  *claude.SessionManager  // Add this

	// ... rest of struct ...
}
```

**Step 2: Initialize SessionManager in Server.New()**

Add initialization after notifications service (step 3.5):

```go
// 3.5. Create Claude session manager
log.Info().Msg("initializing Claude session manager")
claudeManager, err := claude.NewSessionManager()
if err != nil {
	database.Close()
	return nil, fmt.Errorf("failed to create Claude manager: %w", err)
}
s.claudeManager = claudeManager

// Subscribe to session events for SSE notifications
claudeManager.Subscribe(func(event claude.SessionEvent) {
	s.notifService.NotifyClaudeSessionUpdated(event.SessionID, string(event.Type))
})
```

**Step 3: Add accessor method**

Add at the bottom of server.go:

```go
func (s *Server) Claude() *claude.SessionManager { return s.claudeManager }
```

**Step 4: Add shutdown in Server.Shutdown()**

Add before stopping digest worker:

```go
// Shutdown Claude manager (kills all sessions)
if s.claudeManager != nil {
	if err := s.claudeManager.Shutdown(ctx); err != nil {
		log.Error().Err(err).Msg("Claude manager shutdown error")
	}
}
```

**Step 5: Update api/claude.go - Remove global and init functions**

Remove these from `backend/api/claude.go`:
- The global `var sessionManager *claude.SessionManager`
- The `InitClaudeManagerWithNotifications` function
- The `InitClaudeManager` function
- The `ShutdownClaudeManager` function
- The `GetSessionManager` function

**Step 6: Update all handlers to use h.server.Claude()**

Replace all occurrences of `sessionManager` with `h.server.Claude()` in `backend/api/claude.go`.

For example:
```go
// Before
sessions := sessionManager.ListSessions()

// After
sessions := h.server.Claude().ListSessions()
```

**Step 7: Update main.go - Remove Claude init/shutdown calls**

In `backend/main.go`:
- Remove the import of claude package if no longer needed
- Remove the call to `api.InitClaudeManagerWithNotifications(srv.Notifications())`
- Remove the call to `api.ShutdownClaudeManager(ctx)`

**Step 8: Build and verify**

Run: `cd backend && go build .`
Expected: Build succeeds

**Step 9: Commit**

```bash
git add backend/server/server.go backend/api/claude.go backend/main.go
git commit -m "refactor(claude): move SessionManager to server ownership

SessionManager is now owned by server.Server instead of being a global
singleton. This follows the server-centric architecture pattern used
by other components (db, fs, notifications, digest).

- Add claudeManager field to Server struct
- Initialize in Server.New() with SSE subscription
- Add Claude() accessor method
- Shutdown in Server.Shutdown()
- Remove global sessionManager and init functions from api/claude.go
- Update all handlers to use h.server.Claude()"
```

---

## Task 6: Remove Deprecated Manager Code

**Problem:** Old `Manager` struct is deprecated but still in codebase.

**Files:**
- Modify: `backend/claude/manager.go`

**Step 1: Remove deprecated Manager struct and methods**

Keep only the utility functions that are still needed:
- `ErrSessionNotFound`
- `allowedTools` and `disallowedTools`
- `gracefulTerminate`
- `buildClaudeArgs`
- `splitConcatenatedJSON`

Remove everything else (the Manager struct and all its methods).

The file should be reduced to approximately 150 lines containing only:
1. Package declaration and imports
2. Error variables
3. Permission tool lists
4. `gracefulTerminate` function
5. `buildClaudeArgs` function
6. `splitConcatenatedJSON` function

**Step 2: Rename the file to reflect its new purpose**

```bash
mv backend/claude/manager.go backend/claude/process_utils.go
```

**Step 3: Build and verify**

Run: `cd backend && go build .`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add backend/claude/manager.go backend/claude/process_utils.go
git commit -m "refactor(claude): remove deprecated Manager, keep utils

Remove the deprecated Manager struct and all its methods.
Keep utility functions (gracefulTerminate, buildClaudeArgs, etc.)
in renamed file process_utils.go."
```

---

## Task 7: Remove Deprecated SessionIndexCache

**Problem:** Old `SessionIndexCache` is deprecated but still in codebase.

**Files:**
- Delete: `backend/claude/session_index_cache.go`

**Step 1: Delete the file**

```bash
rm backend/claude/session_index_cache.go
```

**Step 2: Build and verify**

Run: `cd backend && go build .`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add backend/claude/session_index_cache.go
git commit -m "refactor(claude): remove deprecated SessionIndexCache

All functionality has been merged into SessionManager.
The SessionIndexCache is no longer used."
```

---

## Task 8: Add Tests for SessionManager

**Files:**
- Create: `backend/claude/session_manager_test.go`

**Step 1: Create test file with subscription tests**

```go
package claude

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSubscribe_ReceivesEvents(t *testing.T) {
	m, err := NewSessionManager()
	if err != nil {
		t.Fatalf("NewSessionManager failed: %v", err)
	}
	defer m.Shutdown(nil)

	var received []SessionEvent
	var mu sync.Mutex

	unsubscribe := m.Subscribe(func(event SessionEvent) {
		mu.Lock()
		received = append(received, event)
		mu.Unlock()
	})
	defer unsubscribe()

	// Emit an event
	m.notify(SessionEvent{Type: SessionEventCreated, SessionID: "test-123"})

	// Wait for event to be processed
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 1 {
		t.Errorf("expected 1 event, got %d", len(received))
	}
	if received[0].SessionID != "test-123" {
		t.Errorf("expected sessionId test-123, got %s", received[0].SessionID)
	}
}

func TestSubscribe_UnsubscribeStopsEvents(t *testing.T) {
	m, err := NewSessionManager()
	if err != nil {
		t.Fatalf("NewSessionManager failed: %v", err)
	}
	defer m.Shutdown(nil)

	var count int32

	unsubscribe := m.Subscribe(func(event SessionEvent) {
		atomic.AddInt32(&count, 1)
	})

	// Emit before unsubscribe
	m.notify(SessionEvent{Type: SessionEventCreated, SessionID: "test-1"})
	time.Sleep(50 * time.Millisecond)

	// Unsubscribe
	unsubscribe()

	// Emit after unsubscribe
	m.notify(SessionEvent{Type: SessionEventCreated, SessionID: "test-2"})
	time.Sleep(50 * time.Millisecond)

	if atomic.LoadInt32(&count) != 1 {
		t.Errorf("expected 1 event before unsubscribe, got %d", atomic.LoadInt32(&count))
	}
}

func TestSubscribe_MultipleSubscribers(t *testing.T) {
	m, err := NewSessionManager()
	if err != nil {
		t.Fatalf("NewSessionManager failed: %v", err)
	}
	defer m.Shutdown(nil)

	var count1, count2 int32

	unsub1 := m.Subscribe(func(event SessionEvent) {
		atomic.AddInt32(&count1, 1)
	})
	defer unsub1()

	unsub2 := m.Subscribe(func(event SessionEvent) {
		atomic.AddInt32(&count2, 1)
	})
	defer unsub2()

	// Emit event
	m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: "test"})
	time.Sleep(50 * time.Millisecond)

	if atomic.LoadInt32(&count1) != 1 || atomic.LoadInt32(&count2) != 1 {
		t.Errorf("expected both subscribers to receive event, got count1=%d count2=%d",
			atomic.LoadInt32(&count1), atomic.LoadInt32(&count2))
	}
}

func TestShutdown_CleansUpSubscribers(t *testing.T) {
	m, err := NewSessionManager()
	if err != nil {
		t.Fatalf("NewSessionManager failed: %v", err)
	}

	var count int32
	m.Subscribe(func(event SessionEvent) {
		atomic.AddInt32(&count, 1)
	})

	// Shutdown without calling unsubscribe
	m.Shutdown(nil)

	// Give goroutines time to exit
	time.Sleep(100 * time.Millisecond)

	// Verify subscriber channel was closed (no panic on notify)
	// This would panic if channels weren't properly closed
	m.subscribersMu.RLock()
	subCount := len(m.subscribers)
	m.subscribersMu.RUnlock()

	if subCount != 0 {
		t.Errorf("expected 0 subscribers after shutdown, got %d", subCount)
	}
}
```

**Step 2: Run tests**

Run: `cd backend && go test -v ./claude/...`
Expected: All tests pass

**Step 3: Commit**

```bash
git add backend/claude/session_manager_test.go
git commit -m "test(claude): add subscription and concurrency tests

Tests cover:
- Subscribe receives events
- Unsubscribe stops events
- Multiple subscribers receive events
- Shutdown cleans up subscribers"
```

---

## Task 9: Update Documentation

**Files:**
- Modify: `docs/plans/2026-02-01-session-manager-refactor.md`

**Step 1: Mark plan as complete**

Add completion status at the top of the file:

```markdown
# Session Manager Refactor

**Status: COMPLETED** (2026-02-01)

## Summary

All phases completed:
- ✅ Phase 1-6: SessionManager implementation and API migration
- ✅ Phase 7: Cleanup (deprecated code removed)
- ✅ Additional fixes: Thread safety, resource leaks, server ownership
```

**Step 2: Commit**

```bash
git add docs/plans/2026-02-01-session-manager-refactor.md
git commit -m "docs: mark session manager refactor as complete"
```

---

## Execution Checklist

| Task | Description | Status |
|------|-------------|--------|
| 1 | Fix lock during I/O | ⬜ |
| 2 | Fix duplicate activation events | ⬜ |
| 3 | Fix Subscribe goroutine leak | ⬜ |
| 4 | Improve event dropping logging | ⬜ |
| 5 | Move to server ownership | ⬜ |
| 6 | Remove deprecated Manager | ⬜ |
| 7 | Remove deprecated SessionIndexCache | ⬜ |
| 8 | Add tests | ⬜ |
| 9 | Update documentation | ⬜ |
