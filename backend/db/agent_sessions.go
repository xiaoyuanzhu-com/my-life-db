package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// ── Agent session CRUD ──────────────────────────────────────────────────────

// AgentSessionRecord represents a full agent session row.
type AgentSessionRecord struct {
	SessionID  string `json:"sessionId"`
	AgentType  string `json:"agentType"`
	WorkingDir string `json:"workingDir"`
	Title      string `json:"title"`
	Source     string `json:"source"`    // "user" or "auto"
	AgentFile  string `json:"agentFile"` // agent definition filename (for auto sessions)
	CreatedAt  int64  `json:"createdAt"`
	UpdatedAt  int64  `json:"updatedAt"`
	ArchivedAt *int64 `json:"archivedAt,omitempty"`
}

// CreateAgentSession inserts a new agent session record.
func CreateAgentSession(sessionID, agentType, workingDir, title, source, agentFile string) error {
	now := NowMs()
	if source == "" {
		source = "user"
	}
	_, err := Run(
		`INSERT INTO agent_sessions (session_id, agent_type, working_dir, title, source, agent_file, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   agent_type = excluded.agent_type,
		   working_dir = excluded.working_dir,
		   title = CASE WHEN excluded.title != '' THEN excluded.title ELSE agent_sessions.title END,
		   source = excluded.source,
		   agent_file = excluded.agent_file,
		   updated_at = excluded.updated_at`,
		sessionID, agentType, workingDir, title, source, agentFile, now, now,
	)
	return err
}

// GetAgentSession retrieves a single session record.
func GetAgentSession(sessionID string) (*AgentSessionRecord, error) {
	var r AgentSessionRecord
	var archivedAt sql.NullInt64
	err := GetDB().QueryRow(
		`SELECT session_id, agent_type, working_dir, title, source, agent_file, created_at, updated_at, archived_at
		 FROM agent_sessions WHERE session_id = ?`,
		sessionID,
	).Scan(&r.SessionID, &r.AgentType, &r.WorkingDir, &r.Title, &r.Source, &r.AgentFile, &r.CreatedAt, &r.UpdatedAt, &archivedAt)
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

// ListAgentSessions returns sessions ordered by most recent activity with cursor-based pagination.
// cursor is the updated_at value of the last item from the previous page (0 for first page).
// limit is the max number of results to return (0 for no limit).
func ListAgentSessions(includeArchived bool, cursor int64, limit int) ([]AgentSessionRecord, error) {
	query := `SELECT session_id, agent_type, working_dir, title, source, agent_file, created_at, updated_at, archived_at
		 FROM agent_sessions`

	var conditions []string
	var params []QueryParam
	if !includeArchived {
		conditions = append(conditions, `archived_at IS NULL`)
	}
	if cursor > 0 {
		conditions = append(conditions, `updated_at < ?`)
		params = append(params, cursor)
	}
	if len(conditions) > 0 {
		query += ` WHERE ` + conditions[0]
		for _, c := range conditions[1:] {
			query += ` AND ` + c
		}
	}
	query += ` ORDER BY updated_at DESC`
	if limit > 0 {
		query += fmt.Sprintf(` LIMIT %d`, limit)
	}

	return Select(query, params, func(rows *sql.Rows) (AgentSessionRecord, error) {
		var r AgentSessionRecord
		var archivedAt sql.NullInt64
		err := rows.Scan(&r.SessionID, &r.AgentType, &r.WorkingDir, &r.Title, &r.Source, &r.AgentFile, &r.CreatedAt, &r.UpdatedAt, &archivedAt)
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

// ArchiveAgentSession marks a session as archived
func ArchiveAgentSession(sessionID string) error {
	_, err := Run(
		`UPDATE agent_sessions SET archived_at = ?, updated_at = ?
		 WHERE session_id = ?`,
		NowMs(), NowMs(), sessionID,
	)
	return err
}

// UnarchiveAgentSession removes the archived mark from a session
func UnarchiveAgentSession(sessionID string) error {
	_, err := Run(
		`UPDATE agent_sessions SET archived_at = NULL, updated_at = ?
		 WHERE session_id = ?`,
		NowMs(), sessionID,
	)
	return err
}

// IsAgentSessionArchived checks if a single session is archived
func IsAgentSessionArchived(sessionID string) (bool, error) {
	return Exists(
		`SELECT 1 FROM agent_sessions WHERE session_id = ? AND archived_at IS NOT NULL`,
		sessionID,
	)
}

// GetArchivedAgentSessionIDs returns all archived session IDs as a set
func GetArchivedAgentSessionIDs() (map[string]bool, error) {
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

// MarkAgentSessionRead records the number of result messages (completed turns)
// that were delivered to the user via WebSocket. Uses upsert with MAX so that
// a client disconnecting with a lower count can never regress the value.
func MarkAgentSessionRead(sessionID string, resultCount int) error {
	_, err := Run(
		`UPDATE agent_sessions
		 SET last_read_count = MAX(?, last_read_count)
		 WHERE session_id = ?`,
		resultCount, sessionID,
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

// SaveAgentSessionPermissionMode persists the permission mode for a session.
// Called when the user changes permission mode via the UI.
func SaveAgentSessionPermissionMode(sessionID string, mode string) error {
	_, err := Run(
		`UPDATE agent_sessions SET permission_mode = ?, updated_at = ?
		 WHERE session_id = ?`,
		mode, NowMs(), sessionID,
	)
	return err
}

// SaveAgentSessionAllowedTools persists the always-allowed tools list for a session.
// The tools slice is stored as a JSON array.
func SaveAgentSessionAllowedTools(sessionID string, tools []string) error {
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

// AgentSessionPreferences holds the persisted preferences for a session.
type AgentSessionPreferences struct {
	SessionID          string
	PermissionMode     string
	AlwaysAllowedTools []string
}

// GetAllAgentSessionPreferences bulk-loads preferences for all sessions that
// have a non-default permission mode or non-empty always-allowed tools.
// Returns a map keyed by session_id.
func GetAllAgentSessionPreferences() (map[string]*AgentSessionPreferences, error) {
	rows, err := Select(
		`SELECT session_id, permission_mode, always_allowed_tools
		 FROM agent_sessions
		 WHERE permission_mode != '' OR always_allowed_tools != '[]'`,
		nil,
		func(rows *sql.Rows) (*AgentSessionPreferences, error) {
			var p AgentSessionPreferences
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
	result := make(map[string]*AgentSessionPreferences, len(rows))
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

// ShareAgentSession sets the share token for a session (upsert).
func ShareAgentSession(sessionID, shareToken string) error {
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

// UnshareAgentSession removes the share token from a session.
func UnshareAgentSession(sessionID string) error {
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
