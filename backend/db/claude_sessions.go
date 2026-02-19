package db

import (
	"database/sql"
)

// ArchiveClaudeSession marks a Claude session as archived
func ArchiveClaudeSession(sessionID string) error {
	_, err := Run(
		`INSERT OR IGNORE INTO archived_claude_sessions (session_id, hidden_at)
		 VALUES (?, ?)`,
		sessionID, NowUTC(),
	)
	return err
}

// UnarchiveClaudeSession removes the archived mark from a Claude session
func UnarchiveClaudeSession(sessionID string) error {
	_, err := Run(
		`DELETE FROM archived_claude_sessions WHERE session_id = ?`,
		sessionID,
	)
	return err
}

// IsClaudeSessionArchived checks if a single session is archived
func IsClaudeSessionArchived(sessionID string) (bool, error) {
	return Exists(
		`SELECT 1 FROM archived_claude_sessions WHERE session_id = ?`,
		sessionID,
	)
}

// GetArchivedClaudeSessionIDs returns all archived session IDs as a set
func GetArchivedClaudeSessionIDs() (map[string]bool, error) {
	rows, err := Select(
		`SELECT session_id FROM archived_claude_sessions`,
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

// ── Session read status (cross-device unread tracking) ──────────────────────

// MarkClaudeSessionRead records the message count the user has seen for a session.
// Uses upsert so it works for both first view and subsequent views.
func MarkClaudeSessionRead(sessionID string, messageCount int) error {
	_, err := Run(
		`INSERT INTO session_read_status (session_id, last_read_message_count, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   last_read_message_count = excluded.last_read_message_count,
		   updated_at = excluded.updated_at`,
		sessionID, messageCount, NowUTC(),
	)
	return err
}

// SessionReadState holds the read status for a single session
type SessionReadState struct {
	SessionID             string
	LastReadMessageCount  int
}

// GetAllSessionReadStates returns the read state for all sessions as a map.
// Key is session_id, value is last_read_message_count.
func GetAllSessionReadStates() (map[string]int, error) {
	rows, err := Select(
		`SELECT session_id, last_read_message_count FROM session_read_status`,
		nil,
		func(rows *sql.Rows) (SessionReadState, error) {
			var s SessionReadState
			err := rows.Scan(&s.SessionID, &s.LastReadMessageCount)
			return s, err
		},
	)
	if err != nil {
		return nil, err
	}
	result := make(map[string]int, len(rows))
	for _, row := range rows {
		result[row.SessionID] = row.LastReadMessageCount
	}
	return result, nil
}
