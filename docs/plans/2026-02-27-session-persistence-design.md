# Session Persistence Across Backend Restarts

**Date:** 2026-02-27
**Status:** Approved

## Problem

When the backend restarts, all Claude session state resets:
- **Permission mode** reverts to default ("Ask") regardless of what the user had set
- **Always-allowed tools** are forgotten — user must re-approve every tool

Backend restarts should be transparent to the user.

## Root Cause

Both `Session.PermissionMode` and `Session.alwaysAllowedTools` are stored **only in memory**. Neither is written to disk or database. On restart, sessions are reloaded from `sessions-index.json` and JSONL files, which contain messages and metadata but not these runtime preferences.

## Design

### Unified `claude_sessions` table

Today, Claude session data is fragmented across two single-purpose tables:
- `archived_claude_sessions` (session_id, hidden_at)
- `session_read_status` (session_id, last_read_message_count, updated_at)

We consolidate both into a single `claude_sessions` table and extend it with the new persistence fields.

### Migration 012

```sql
CREATE TABLE claude_sessions (
    session_id            TEXT PRIMARY KEY,
    archived_at           INTEGER,
    last_read_count       INTEGER NOT NULL DEFAULT 0,
    permission_mode       TEXT NOT NULL DEFAULT '',
    always_allowed_tools  TEXT NOT NULL DEFAULT '[]',
    updated_at            INTEGER NOT NULL DEFAULT 0
);

-- Migrate existing data
INSERT INTO claude_sessions (session_id, archived_at, updated_at)
    SELECT session_id, hidden_at, hidden_at
    FROM archived_claude_sessions;

INSERT INTO claude_sessions (session_id, last_read_count, updated_at)
    SELECT session_id, last_read_message_count, updated_at
    FROM session_read_status
    ON CONFLICT(session_id) DO UPDATE SET
        last_read_count = excluded.last_read_count,
        updated_at = MAX(claude_sessions.updated_at, excluded.updated_at);

-- Drop old tables (IF EXISTS for safety)
DROP TABLE IF EXISTS archived_claude_sessions;
DROP TABLE IF EXISTS session_read_status;
```

**Fresh-install safe:** Migrations run sequentially. By the time 012 runs, migrations 006/007/009 have already created the old tables (empty on fresh install). SELECTs return 0 rows, DROPs clean up.

### Column semantics

| Column | Type | Description |
|--------|------|-------------|
| `session_id` | TEXT PK | Claude session UUID |
| `archived_at` | INTEGER (nullable) | Epoch ms when archived; NULL = not archived |
| `last_read_count` | INTEGER | Result-delivery count for cross-device unread tracking |
| `permission_mode` | TEXT | e.g. "default", "acceptEdits", "plan", "bypassPermissions"; empty = unset |
| `always_allowed_tools` | TEXT | JSON array of tool names, e.g. `["Bash","Read"]` |
| `updated_at` | INTEGER | Epoch ms of last modification |

### DB functions (`claude_sessions.go`)

**Updated (point at `claude_sessions` table):**
- `ArchiveClaudeSession(sessionID)` — upsert, set `archived_at`
- `UnarchiveClaudeSession(sessionID)` — set `archived_at = NULL`
- `IsClaudeSessionArchived(sessionID)` — check `archived_at IS NOT NULL`
- `GetArchivedClaudeSessionIDs()` — filter `archived_at IS NOT NULL`
- `MarkClaudeSessionRead(sessionID, count)` — upsert `last_read_count`
- `GetAllSessionReadStates()` — select where `last_read_count > 0`

**New:**
- `SaveClaudeSessionPermissionMode(sessionID, mode)` — upsert permission mode
- `SaveClaudeSessionAllowedTools(sessionID, tools []string)` — upsert JSON array
- `GetClaudeSessionPreferences(sessionID)` — returns mode + tools for one session
- `GetAllClaudeSessionPreferences()` — bulk load map[sessionID] -> (mode, tools)

### Persistence triggers

**Permission mode** — saved when:
- `set_permission_mode` control request handled in WebSocket handler (`api/claude.go`)
- After storing on `session.PermissionMode`, call DB save

**Always-allowed tools** — saved when:
- User clicks "Always allow" in `SendControlResponse()` (`session.go`)
- After adding to `session.alwaysAllowedTools` map, call DB save

### Session loading on startup

In `loadFromIndexFiles()` / `newHistoricalSessionFromIndex()`:
1. Bulk-load all preferences via `GetAllClaudeSessionPreferences()`
2. For each loaded session:
   - Set `session.PermissionMode` from DB value
   - Populate `session.alwaysAllowedTools` map from DB JSON array
3. When session is later activated (`EnsureActivated()`), the persisted mode is passed to the Claude CLI via `--permission-mode` flag

### User-facing impact

None. Backend restarts become transparent. No UI changes needed.
