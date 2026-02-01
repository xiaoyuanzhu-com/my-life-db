# Session Manager Refactor

## Problem

The current Claude session management has split responsibilities:

- **SessionIndexCache** - tracks file-based metadata (from JSONL files)
- **Manager** - tracks running processes (activation state)
- **Notifications** - wired via callback from cache's FS watcher

This causes issues:
1. Activation/deactivation doesn't trigger SSE notifications (only file changes do)
2. Cross-tab sync is incomplete - other tabs don't see when sessions activate
3. API handlers must merge two data sources (cache + manager)
4. Notification logic is buried in the FS watcher instead of mutation methods

## Solution

Create a unified **SessionManager** that is the single source of truth for all session state.

```
┌────────────────────────────────────────────────────────────┐
│                     SessionManager                          │
│         (single source of truth for all session state)     │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Internal State:                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   sessions   │  │  processes   │  │ subscribers  │     │
│  │ map[id]Entry │  │ map[id]*Proc │  │ []callback   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│                                                            │
│  Data Sources (internal):                                  │
│  - FS watcher → updates session metadata                   │
│  - Process lifecycle → updates activation state            │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  Public API:                                               │
│                                                            │
│  // Queries                                                │
│  GetSession(id) → *Session                                 │
│  ListSessions(filter, pagination) → []Session              │
│                                                            │
│  // Mutations (all trigger events)                         │
│  CreateSession(opts) → *Session                            │
│  ActivateSession(id) → error                               │
│  DeactivateSession(id) → error                             │
│  DeleteSession(id) → error                                 │
│                                                            │
│  // Subscriptions                                          │
│  Subscribe(callback) → unsubscribe func                    │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Single source of truth** - SessionManager owns all session state
2. **Event-driven** - All mutations emit events, subscribers react
3. **Internal aggregation** - FS watcher and process lifecycle are internal details
4. **Clean API** - Callers don't need to know about data sources

## Data Model

### SessionEntry (internal cache)

```go
type SessionEntry struct {
    // Identity
    SessionID   string
    FullPath    string  // Path to JSONL file
    ProjectPath string  // Working directory

    // Metadata (from filesystem)
    DisplayTitle         string
    FirstPrompt          string
    FirstUserMessageUUID string
    Summary              string
    CustomTitle          string
    MessageCount         int
    Created              time.Time
    Modified             time.Time
    GitBranch            string
    IsSidechain          bool

    // Runtime state (from process management)
    IsActivated bool
    ProcessID   int
    Status      string // "active", "archived", "dead"
}
```

### SessionEvent

```go
type SessionEvent struct {
    Type      string // "created", "updated", "activated", "deactivated", "deleted"
    SessionID string
    Entry     *SessionEntry // Current state (nil for deleted)
}
```

## Implementation Plan

### Phase 1: Create unified SessionManager

1. Create new file `backend/claude/session_manager.go`
2. Define `SessionManager` struct combining:
   - Session entries map (from SessionIndexCache)
   - Active processes map (from Manager)
   - Subscriber list
3. Implement core methods:
   - `NewSessionManager()` - creates manager, starts FS watcher
   - `Shutdown()` - graceful shutdown

### Phase 2: Implement query methods

1. `GetSession(id)` - returns merged session data
2. `ListSessions(opts)` - paginated list with filters
3. Internal helper to merge file metadata + process state

### Phase 3: Implement mutation methods with events

1. `CreateSession(opts)` - spawn process, add to state, emit "created"+"activated"
2. `ActivateSession(id)` - spawn process for archived session, emit "activated"
3. `DeactivateSession(id)` - stop process, emit "deactivated"
4. `DeleteSession(id)` - stop process, remove from state, emit "deleted"

### Phase 4: Implement subscription system

1. `Subscribe(callback)` - register for events
2. `notify(event)` - internal method to broadcast to subscribers
3. Wire notifications service as a subscriber

### Phase 5: Refactor FS watcher

1. Move watcher logic into SessionManager
2. FS events call internal mutation methods
3. Mutation methods emit events (unified path)

### Phase 6: Update API handlers

1. Replace `claudeManager` with new SessionManager
2. Remove `SessionIndexCache` direct usage
3. Wire SSE via Subscribe()

### Phase 7: Cleanup

1. Remove old `Manager` struct
2. Remove old `SessionIndexCache` (or keep as internal implementation detail)
3. Update tests

## Files Changed

| File | Change |
|------|--------|
| `backend/claude/session_manager.go` | NEW - unified manager |
| `backend/claude/manager.go` | DELETE or merge into session_manager |
| `backend/claude/session_index_cache.go` | DELETE or make internal |
| `backend/api/claude.go` | UPDATE - use new SessionManager |
| `backend/main.go` | UPDATE - initialize SessionManager |

## Event Types

| Event | Triggered By | Data |
|-------|--------------|------|
| `created` | New session created (process started) | Full entry |
| `updated` | File metadata changed (title, summary) | Full entry |
| `activated` | Archived session resumed | Full entry |
| `deactivated` | Active session stopped | Full entry |
| `deleted` | Session removed | Session ID only |

## Migration Strategy

1. Implement new SessionManager alongside existing code
2. Update API handlers to use new manager
3. Verify functionality
4. Remove old code

## Testing

- Unit tests for SessionManager methods
- Integration test for event subscription
- Manual test: open two tabs, verify cross-tab sync for:
  - New session created
  - Session archived
  - Session activated
