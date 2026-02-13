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
