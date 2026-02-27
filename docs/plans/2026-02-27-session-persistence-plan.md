# Session Persistence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist permission mode and always-allowed tools across backend restarts by consolidating session data into a unified `claude_sessions` table.

**Architecture:** New DB migration merges `archived_claude_sessions` + `session_read_status` into one `claude_sessions` table with new `permission_mode` and `always_allowed_tools` columns. Existing DB functions repointed to new table. New persistence triggers save state on change; startup loads persisted state into session objects.

**Tech Stack:** Go 1.25, SQLite (via `database/sql`), existing `db.Run`/`db.Select`/`db.Exists` helpers

**Build/test note:** Go toolchain is on the Mac mini. Run builds and tests via `ssh macmini`. The worktree path on Mac mini matches the local path.

---

### Task 1: Migration — Create unified `claude_sessions` table

**Files:**
- Create: `backend/db/migration_012_claude_sessions.go`

**Step 1: Write the migration file**

Create `backend/db/migration_012_claude_sessions.go`:

```go
package db

import (
	"database/sql"
)

func init() {
	RegisterMigration(Migration{
		Version:     12,
		Description: "Consolidate claude session tables into unified claude_sessions",
		Up:          migration012_claudeSessions,
	})
}

func migration012_claudeSessions(db *sql.DB) error {
	// Create the unified table
	if _, err := db.Exec(`
		CREATE TABLE claude_sessions (
			session_id           TEXT PRIMARY KEY,
			archived_at          INTEGER,
			last_read_count      INTEGER NOT NULL DEFAULT 0,
			permission_mode      TEXT NOT NULL DEFAULT '',
			always_allowed_tools TEXT NOT NULL DEFAULT '[]',
			updated_at           INTEGER NOT NULL DEFAULT 0
		)
	`); err != nil {
		return err
	}

	// Migrate archived sessions
	if _, err := db.Exec(`
		INSERT INTO claude_sessions (session_id, archived_at, updated_at)
		SELECT session_id, hidden_at, hidden_at
		FROM archived_claude_sessions
	`); err != nil {
		return err
	}

	// Migrate read status (merge with ON CONFLICT for sessions that are both archived and have read state)
	if _, err := db.Exec(`
		INSERT INTO claude_sessions (session_id, last_read_count, updated_at)
		SELECT session_id, last_read_message_count, updated_at
		FROM session_read_status
		ON CONFLICT(session_id) DO UPDATE SET
			last_read_count = excluded.last_read_count,
			updated_at = MAX(claude_sessions.updated_at, excluded.updated_at)
	`); err != nil {
		return err
	}

	// Drop old tables (IF EXISTS for safety)
	if _, err := db.Exec(`DROP TABLE IF EXISTS archived_claude_sessions`); err != nil {
		return err
	}
	if _, err := db.Exec(`DROP TABLE IF EXISTS session_read_status`); err != nil {
		return err
	}

	return nil
}
```

**Step 2: Build to verify compilation**

Run: `ssh macmini "cd <worktree-path>/backend && go build ./..."`
Expected: Clean build, no errors.

**Step 3: Commit**

```bash
git add backend/db/migration_012_claude_sessions.go
git commit -m "feat(db): migration 012 — unified claude_sessions table

Merges archived_claude_sessions and session_read_status into a single
claude_sessions table. Adds permission_mode and always_allowed_tools
columns for restart persistence."
```

---

### Task 2: Repoint existing DB functions to new table

**Files:**
- Modify: `backend/db/claude_sessions.go` (all functions)

The existing functions reference `archived_claude_sessions` and `session_read_status`. Update them to use `claude_sessions`.

**Step 1: Rewrite `claude_sessions.go`**

Replace the entire file with:

```go
package db

import (
	"database/sql"
	"encoding/json"
)

// ── Archive operations ───────────────────────────────────────────────────────

// ArchiveClaudeSession marks a Claude session as archived
func ArchiveClaudeSession(sessionID string) error {
	_, err := Run(
		`INSERT INTO claude_sessions (session_id, archived_at, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   archived_at = excluded.archived_at,
		   updated_at = excluded.updated_at`,
		sessionID, NowMs(), NowMs(),
	)
	return err
}

// UnarchiveClaudeSession removes the archived mark from a Claude session
func UnarchiveClaudeSession(sessionID string) error {
	_, err := Run(
		`UPDATE claude_sessions SET archived_at = NULL, updated_at = ?
		 WHERE session_id = ?`,
		NowMs(), sessionID,
	)
	return err
}

// IsClaudeSessionArchived checks if a single session is archived
func IsClaudeSessionArchived(sessionID string) (bool, error) {
	return Exists(
		`SELECT 1 FROM claude_sessions WHERE session_id = ? AND archived_at IS NOT NULL`,
		sessionID,
	)
}

// GetArchivedClaudeSessionIDs returns all archived session IDs as a set
func GetArchivedClaudeSessionIDs() (map[string]bool, error) {
	rows, err := Select(
		`SELECT session_id FROM claude_sessions WHERE archived_at IS NOT NULL`,
		nil,
		func(rows *sql.Rows) (string, error) {
			var id string
			err := rows.Scan(&id)
			return id, err
		},
	)
	if err != nil {
		return nil, err
	}
	result := make(map[string]bool, len(rows))
	for _, id := range rows {
		result[id] = true
	}
	return result, nil
}

// ── Read status operations ───────────────────────────────────────────────────

// MarkClaudeSessionRead records the number of result messages (completed turns)
// that were delivered to the user via WebSocket. Uses upsert with MAX so that
// a client disconnecting with a lower count can never regress the value.
func MarkClaudeSessionRead(sessionID string, resultCount int) error {
	_, err := Run(
		`INSERT INTO claude_sessions (session_id, last_read_count, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   last_read_count = MAX(excluded.last_read_count, claude_sessions.last_read_count),
		   updated_at = excluded.updated_at`,
		sessionID, resultCount, NowMs(),
	)
	return err
}

// SessionReadState holds the read status for a single session
type SessionReadState struct {
	SessionID           string
	LastReadResultCount int
}

// GetAllSessionReadStates returns the read state for all sessions as a map.
// Key is session_id, value is last-read result count (completed turns).
func GetAllSessionReadStates() (map[string]int, error) {
	rows, err := Select(
		`SELECT session_id, last_read_count FROM claude_sessions WHERE last_read_count > 0`,
		nil,
		func(rows *sql.Rows) (SessionReadState, error) {
			var s SessionReadState
			err := rows.Scan(&s.SessionID, &s.LastReadResultCount)
			return s, err
		},
	)
	if err != nil {
		return nil, err
	}
	result := make(map[string]int, len(rows))
	for _, row := range rows {
		result[row.SessionID] = row.LastReadResultCount
	}
	return result, nil
}

// ── Session preferences (permission mode + always-allowed tools) ─────────────

// SaveClaudeSessionPermissionMode persists the permission mode for a session.
// Called when the user changes permission mode via the UI.
func SaveClaudeSessionPermissionMode(sessionID string, mode string) error {
	_, err := Run(
		`INSERT INTO claude_sessions (session_id, permission_mode, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   permission_mode = excluded.permission_mode,
		   updated_at = excluded.updated_at`,
		sessionID, mode, NowMs(),
	)
	return err
}

// SaveClaudeSessionAllowedTools persists the always-allowed tools list for a session.
// The tools slice is stored as a JSON array.
func SaveClaudeSessionAllowedTools(sessionID string, tools []string) error {
	toolsJSON, err := json.Marshal(tools)
	if err != nil {
		return err
	}
	_, err = Run(
		`INSERT INTO claude_sessions (session_id, always_allowed_tools, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   always_allowed_tools = excluded.always_allowed_tools,
		   updated_at = excluded.updated_at`,
		sessionID, string(toolsJSON), NowMs(),
	)
	return err
}

// ClaudeSessionPreferences holds the persisted preferences for a session.
type ClaudeSessionPreferences struct {
	SessionID         string
	PermissionMode    string
	AlwaysAllowedTools []string
}

// GetAllClaudeSessionPreferences bulk-loads preferences for all sessions that
// have a non-default permission mode or non-empty always-allowed tools.
// Returns a map keyed by session_id.
func GetAllClaudeSessionPreferences() (map[string]*ClaudeSessionPreferences, error) {
	rows, err := Select(
		`SELECT session_id, permission_mode, always_allowed_tools
		 FROM claude_sessions
		 WHERE permission_mode != '' OR always_allowed_tools != '[]'`,
		nil,
		func(rows *sql.Rows) (*ClaudeSessionPreferences, error) {
			var p ClaudeSessionPreferences
			var toolsJSON string
			if err := rows.Scan(&p.SessionID, &p.PermissionMode, &toolsJSON); err != nil {
				return nil, err
			}
			if toolsJSON != "" && toolsJSON != "[]" {
				if err := json.Unmarshal([]byte(toolsJSON), &p.AlwaysAllowedTools); err != nil {
					// Non-fatal: log and continue with empty list
					p.AlwaysAllowedTools = nil
				}
			}
			return &p, nil
		},
	)
	if err != nil {
		return nil, err
	}
	result := make(map[string]*ClaudeSessionPreferences, len(rows))
	for _, p := range rows {
		result[p.SessionID] = p
	}
	return result, nil
}
```

**Step 2: Build to verify compilation**

Run: `ssh macmini "cd <worktree-path>/backend && go build ./..."`
Expected: Clean build, no errors.

**Step 3: Commit**

```bash
git add backend/db/claude_sessions.go
git commit -m "refactor(db): repoint session functions to unified claude_sessions table

All archive, read-status, and new preference functions now use the
claude_sessions table. Adds SaveClaudeSessionPermissionMode,
SaveClaudeSessionAllowedTools, and GetAllClaudeSessionPreferences."
```

---

### Task 3: Load persisted preferences on startup

**Files:**
- Modify: `backend/claude/session_manager.go` (functions: `ensureInitialized`, `loadFromIndexFiles`, `newHistoricalSessionFromIndex`, `newHistoricalSessionFromMetadata`)

**Step 1: Add preference loading to `ensureInitialized`**

In `session_manager.go`, inside `ensureInitialized()`, after `m.loadFromIndexFiles()` and `m.scanForMissingJSONL()` (around line 723), add a call to apply persisted preferences:

```go
// After line 723 (m.scanForMissingJSONL())
m.applyPersistedPreferences()
```

**Step 2: Add the `applyPersistedPreferences` method**

Add this new method to `session_manager.go` (after `scanForMissingJSONL`):

```go
// applyPersistedPreferences loads permission mode and always-allowed tools
// from the database and applies them to loaded sessions. This makes backend
// restarts transparent — sessions retain their preferences.
func (m *SessionManager) applyPersistedPreferences() {
	// Wrap in recover() like ListAllSessions does, because DB may not be
	// initialized in tests.
	var prefs map[string]*db.ClaudeSessionPreferences
	func() {
		defer func() {
			if r := recover(); r != nil {
				log.Warn().Msgf("recovered from panic loading session preferences: %v", r)
			}
		}()
		var err error
		prefs, err = db.GetAllClaudeSessionPreferences()
		if err != nil {
			log.Warn().Err(err).Msg("failed to load session preferences")
		}
	}()

	if prefs == nil {
		return
	}

	applied := 0
	for sessionID, pref := range prefs {
		session, exists := m.sessions[sessionID]
		if !exists {
			continue
		}

		if pref.PermissionMode != "" {
			session.PermissionMode = sdk.PermissionMode(pref.PermissionMode)
		}

		if len(pref.AlwaysAllowedTools) > 0 {
			session.alwaysAllowedTools = make(map[string]bool, len(pref.AlwaysAllowedTools))
			for _, tool := range pref.AlwaysAllowedTools {
				session.alwaysAllowedTools[tool] = true
			}
		}

		applied++
	}

	if applied > 0 {
		log.Info().Int("count", applied).Msg("applied persisted session preferences")
	}
}
```

**Step 3: Build to verify compilation**

Run: `ssh macmini "cd <worktree-path>/backend && go build ./..."`
Expected: Clean build, no errors.

**Step 4: Run existing tests**

Run: `ssh macmini "cd <worktree-path>/backend && go test ./claude/... -v -count=1 2>&1 | tail -30"`
Expected: All existing tests pass (the `recover()` wrapper ensures tests without DB still work).

**Step 5: Commit**

```bash
git add backend/claude/session_manager.go
git commit -m "feat: load persisted session preferences on startup

applyPersistedPreferences() runs during SessionManager initialization,
restoring permission mode and always-allowed tools from the database.
Uses recover() wrapper for test safety (no DB in unit tests)."
```

---

### Task 4: Persist permission mode on change

**Files:**
- Modify: `backend/api/claude.go` (inside `set_permission_mode` handler, around line 785)

**Step 1: Add DB save after permission mode change succeeds**

In `backend/api/claude.go`, after the success log at line 785 (`Msg("permission mode changed")`), and before the response broadcast at line 789, add:

```go
// Persist to database (fire-and-forget; don't block the WebSocket response)
if err := db.SaveClaudeSessionPermissionMode(sessionID, modeReq.Request.Mode); err != nil {
	log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist permission mode")
}
```

Make sure the `db` import is already present (it should be — check the import block at the top of `claude.go`).

**Step 2: Build to verify compilation**

Run: `ssh macmini "cd <worktree-path>/backend && go build ./..."`
Expected: Clean build, no errors.

**Step 3: Commit**

```bash
git add backend/api/claude.go
git commit -m "feat: persist permission mode to DB on change

When user changes permission mode via the UI, save it to the
claude_sessions table so it survives backend restarts."
```

---

### Task 5: Persist always-allowed tools on change

**Files:**
- Modify: `backend/claude/session.go` (inside `SendControlResponse`, around line 434-439)

**Step 1: Add DB save after tool is added to always-allowed list**

In `backend/claude/session.go`, inside `SendControlResponse()`, after the tool is added to the in-memory map and the log message (around line 439), add persistence logic. The tricky part: we need the full tool list as a slice for the DB, so we read it under the same lock:

Replace the existing always-allow block (lines 428-440):

```go
	// Handle "always allow" — remember this tool for future auto-approval
	if alwaysAllow && behavior == "allow" && toolName != "" {
		s.alwaysAllowedToolsMu.Lock()
		if s.alwaysAllowedTools == nil {
			s.alwaysAllowedTools = make(map[string]bool)
		}
		s.alwaysAllowedTools[toolName] = true

		// Snapshot tool list for persistence while holding the lock
		tools := make([]string, 0, len(s.alwaysAllowedTools))
		for t := range s.alwaysAllowedTools {
			tools = append(tools, t)
		}
		s.alwaysAllowedToolsMu.Unlock()

		log.Info().
			Str("sessionId", s.ID).
			Str("toolName", toolName).
			Msg("tool added to always-allowed list")

		// Persist to database (fire-and-forget)
		if err := db.SaveClaudeSessionAllowedTools(s.ID, tools); err != nil {
			log.Warn().Err(err).Str("sessionId", s.ID).Msg("failed to persist always-allowed tools")
		}
	}
```

This requires adding the `db` import to `session.go`. Add to the import block:

```go
"github.com/xiaoyuanzhu-com/my-life-db/db"
```

**Step 2: Build to verify compilation**

Run: `ssh macmini "cd <worktree-path>/backend && go build ./..."`
Expected: Clean build, no errors.

**Step 3: Run all tests**

Run: `ssh macmini "cd <worktree-path>/backend && go test ./... -count=1 2>&1 | tail -20"`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add backend/claude/session.go
git commit -m "feat: persist always-allowed tools to DB on change

When user clicks 'Always allow' for a tool, snapshot the full tool
list and save it to the claude_sessions table for restart persistence."
```

---

### Task 6: Manual integration test

No automated integration test infrastructure exists for the DB layer in this project. Verify the full flow manually.

**Step 1: Build and deploy to Mac mini**

Run: `ssh macmini "cd <worktree-path>/backend && go build -o /tmp/mylifedb-test ./cmd/server"`
Expected: Binary builds successfully.

**Step 2: Verify migration runs on fresh DB**

Run: `ssh macmini "rm -f /tmp/test-session-persist.db && MYLIFEDB_DB_PATH=/tmp/test-session-persist.db /tmp/mylifedb-test --help 2>&1 || true"`

Check logs for: `applying migration` messages 1-12, no errors.

**Step 3: Test the full flow**

1. Start the app normally
2. Open a Claude session, change permission mode to something other than "Ask" (e.g., "Plan")
3. Verify the mode shows correctly
4. Restart the backend
5. Reopen the same session — permission mode should still be "Plan"
6. Repeat with "Always allow" — click always allow on a tool, restart, verify the tool is still auto-approved

**Step 4: Commit (no code changes — this is verification only)**

No commit needed. If issues found, fix them in the relevant task's file and amend.

---

### Summary of files changed

| File | Action | Description |
|------|--------|-------------|
| `backend/db/migration_012_claude_sessions.go` | Create | New migration: unified table, data migration, drop old tables |
| `backend/db/claude_sessions.go` | Rewrite | All functions repointed to `claude_sessions` + new preference functions |
| `backend/claude/session_manager.go` | Modify | Add `applyPersistedPreferences()`, call from `ensureInitialized()` |
| `backend/api/claude.go` | Modify | Add `db.SaveClaudeSessionPermissionMode()` call in set_permission_mode handler |
| `backend/claude/session.go` | Modify | Add `db.SaveClaudeSessionAllowedTools()` call in SendControlResponse |
