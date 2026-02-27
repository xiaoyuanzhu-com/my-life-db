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
	SessionID          string
	PermissionMode     string
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
