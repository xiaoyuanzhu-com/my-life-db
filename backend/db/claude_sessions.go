package db

import (
	"database/sql"
	"encoding/json"
)

// ── Agent session CRUD ──────────────────────────────────────────────────────

// AgentSessionRecord represents a full agent session row.
type AgentSessionRecord struct {
	SessionID  string `json:"sessionId"`
	AgentType  string `json:"agentType"`
	WorkingDir string `json:"workingDir"`
	Title      string `json:"title"`
	CreatedAt  int64  `json:"createdAt"`
	UpdatedAt  int64  `json:"updatedAt"`
	ArchivedAt *int64 `json:"archivedAt,omitempty"`
}

// CreateAgentSession inserts a new agent session record.
func CreateAgentSession(sessionID, agentType, workingDir, title string) error {
	now := NowMs()
	_, err := Run(
		`INSERT INTO agent_sessions (session_id, agent_type, working_dir, title, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   agent_type = excluded.agent_type,
		   working_dir = excluded.working_dir,
		   title = CASE WHEN excluded.title != '' THEN excluded.title ELSE agent_sessions.title END,
		   updated_at = excluded.updated_at`,
		sessionID, agentType, workingDir, title, now, now,
	)
	return err
}

// GetAgentSession retrieves a single session record.
func GetAgentSession(sessionID string) (*AgentSessionRecord, error) {
	var r AgentSessionRecord
	var archivedAt sql.NullInt64
	err := GetDB().QueryRow(
		`SELECT session_id, agent_type, working_dir, title, created_at, updated_at, archived_at
		 FROM agent_sessions WHERE session_id = ?`,
		sessionID,
	).Scan(&r.SessionID, &r.AgentType, &r.WorkingDir, &r.Title, &r.CreatedAt, &r.UpdatedAt, &archivedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if archivedAt.Valid {
		r.ArchivedAt = &archivedAt.Int64
	}
	return &r, nil
}

// ListAgentSessions returns all non-archived sessions ordered by most recent activity.
func ListAgentSessions(includeArchived bool) ([]AgentSessionRecord, error) {
	query := `SELECT session_id, agent_type, working_dir, title, created_at, updated_at, archived_at
		 FROM agent_sessions`
	if !includeArchived {
		query += ` WHERE archived_at IS NULL`
	}
	query += ` ORDER BY updated_at DESC`

	return Select(query, nil, func(rows *sql.Rows) (AgentSessionRecord, error) {
		var r AgentSessionRecord
		var archivedAt sql.NullInt64
		err := rows.Scan(&r.SessionID, &r.AgentType, &r.WorkingDir, &r.Title, &r.CreatedAt, &r.UpdatedAt, &archivedAt)
		if archivedAt.Valid {
			r.ArchivedAt = &archivedAt.Int64
		}
		return r, err
	})
}

// UpdateAgentSessionTitle updates the title for a session.
func UpdateAgentSessionTitle(sessionID, title string) error {
	_, err := Run(
		`UPDATE agent_sessions SET title = ?, updated_at = ? WHERE session_id = ?`,
		title, NowMs(), sessionID,
	)
	return err
}

// TouchAgentSession updates the updated_at timestamp.
func TouchAgentSession(sessionID string) error {
	_, err := Run(
		`UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?`,
		NowMs(), sessionID,
	)
	return err
}

// ── Archive operations ───────────────────────────────────────────────────────

// ArchiveClaudeSession marks a Claude session as archived
func ArchiveClaudeSession(sessionID string) error {
	_, err := Run(
		`INSERT INTO agent_sessions (session_id, archived_at, updated_at)
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
		`UPDATE agent_sessions SET archived_at = NULL, updated_at = ?
		 WHERE session_id = ?`,
		NowMs(), sessionID,
	)
	return err
}

// IsClaudeSessionArchived checks if a single session is archived
func IsClaudeSessionArchived(sessionID string) (bool, error) {
	return Exists(
		`SELECT 1 FROM agent_sessions WHERE session_id = ? AND archived_at IS NOT NULL`,
		sessionID,
	)
}

// GetArchivedClaudeSessionIDs returns all archived session IDs as a set
func GetArchivedClaudeSessionIDs() (map[string]bool, error) {
	rows, err := Select(
		`SELECT session_id FROM agent_sessions WHERE archived_at IS NOT NULL`,
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
		`INSERT INTO agent_sessions (session_id, last_read_count, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   last_read_count = MAX(excluded.last_read_count, agent_sessions.last_read_count),
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
		`SELECT session_id, last_read_count FROM agent_sessions WHERE last_read_count > 0`,
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
		`INSERT INTO agent_sessions (session_id, permission_mode, updated_at)
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
		`INSERT INTO agent_sessions (session_id, always_allowed_tools, updated_at)
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
		 FROM agent_sessions
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

// GetAgentSessionPermissionMode returns the permission_mode for a single session.
// Returns "" if the session doesn't exist or has no permission mode set.
func GetAgentSessionPermissionMode(sessionID string) (string, error) {
	var mode string
	err := GetDB().QueryRow(
		`SELECT permission_mode FROM agent_sessions WHERE session_id = ?`,
		sessionID,
	).Scan(&mode)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return mode, nil
}

// ── Share operations ─────────────────────────────────────────────────────────

// ShareClaudeSession sets the share token for a session (upsert).
func ShareClaudeSession(sessionID, shareToken string) error {
	_, err := Run(
		`INSERT INTO agent_sessions (session_id, share_token, shared_at, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   share_token = excluded.share_token,
		   shared_at = excluded.shared_at,
		   updated_at = excluded.updated_at`,
		sessionID, shareToken, NowMs(), NowMs(),
	)
	return err
}

// UnshareClaudeSession removes the share token from a session.
func UnshareClaudeSession(sessionID string) error {
	_, err := Run(
		`UPDATE agent_sessions SET share_token = NULL, shared_at = NULL, updated_at = ?
		 WHERE session_id = ?`,
		NowMs(), sessionID,
	)
	return err
}

// GetSessionIDByShareToken resolves a share token to a session ID.
// Returns "" if the token is not found.
func GetSessionIDByShareToken(shareToken string) (string, error) {
	var sessionID string
	err := GetDB().QueryRow(
		`SELECT session_id FROM agent_sessions WHERE share_token = ?`,
		shareToken,
	).Scan(&sessionID)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return sessionID, nil
}

// GetShareToken returns the share token for a session.
// Returns "" if the session is not shared.
func GetShareToken(sessionID string) (string, error) {
	var token sql.NullString
	err := GetDB().QueryRow(
		`SELECT share_token FROM agent_sessions WHERE session_id = ?`,
		sessionID,
	).Scan(&token)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !token.Valid {
		return "", nil
	}
	return token.String, nil
}

// ShareTokenEntry holds a session ID and its share token.
type ShareTokenEntry struct {
	SessionID  string
	ShareToken string
}

// GetAllShareTokens bulk-loads all share tokens as a sessionID -> shareToken map.
func GetAllShareTokens() (map[string]string, error) {
	rows, err := Select(
		`SELECT session_id, share_token FROM agent_sessions WHERE share_token IS NOT NULL`,
		nil,
		func(rows *sql.Rows) (ShareTokenEntry, error) {
			var e ShareTokenEntry
			err := rows.Scan(&e.SessionID, &e.ShareToken)
			return e, err
		},
	)
	if err != nil {
		return nil, err
	}
	result := make(map[string]string, len(rows))
	for _, e := range rows {
		result[e.SessionID] = e.ShareToken
	}
	return result, nil
}
