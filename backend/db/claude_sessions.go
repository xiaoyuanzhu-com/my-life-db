package db

import (
	"database/sql"
)

// HideClaudeSession marks a Claude session as hidden
func HideClaudeSession(sessionID string) error {
	_, err := Run(
		`INSERT OR IGNORE INTO hidden_claude_sessions (session_id, hidden_at)
		 VALUES (?, ?)`,
		sessionID, NowUTC(),
	)
	return err
}

// UnhideClaudeSession removes the hidden mark from a Claude session
func UnhideClaudeSession(sessionID string) error {
	_, err := Run(
		`DELETE FROM hidden_claude_sessions WHERE session_id = ?`,
		sessionID,
	)
	return err
}

// IsClaudeSessionHidden checks if a single session is hidden
func IsClaudeSessionHidden(sessionID string) (bool, error) {
	return Exists(
		`SELECT 1 FROM hidden_claude_sessions WHERE session_id = ?`,
		sessionID,
	)
}

// GetHiddenClaudeSessionIDs returns all hidden session IDs as a set
func GetHiddenClaudeSessionIDs() (map[string]bool, error) {
	rows, err := Select(
		`SELECT session_id FROM hidden_claude_sessions`,
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
