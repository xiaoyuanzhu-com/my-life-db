package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

// ── Agent session CRUD ──────────────────────────────────────────────────────

// AgentSessionRecord represents a full agent session row.
type AgentSessionRecord struct {
	SessionID   string  `json:"sessionId"`
	AgentType   string  `json:"agentType"`
	WorkingDir  string  `json:"workingDir"`
	Title       string  `json:"title"`
	Source      string  `json:"source"`      // "user" or "auto"
	AgentName   string  `json:"agentName"`   // agent folder name (for auto sessions)
	TriggerKind string  `json:"triggerKind"` // e.g. "cron.tick", "file.created" (auto sessions)
	TriggerData string  `json:"triggerData"` // JSON-encoded hooks.Payload.Data (auto sessions)
	StorageID   string  `json:"storageId"`
	GroupID     *string `json:"groupId,omitempty"`
	PinnedAt    *int64  `json:"pinnedAt,omitempty"`
	CreatedAt   int64   `json:"createdAt"`
	UpdatedAt   int64   `json:"updatedAt"`
	ArchivedAt  *int64  `json:"archivedAt,omitempty"`
}

// CreateAgentSession inserts a new agent session record.
// triggerKind / triggerData are populated only for auto sessions; pass empty strings otherwise.
func (d *DB) CreateAgentSession(ctx context.Context, sessionID, agentType, workingDir, title, source, agentName, triggerKind, triggerData, storageID string) error {
	now := NowMs()
	if source == "" {
		source = "user"
	}
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`INSERT INTO agent_sessions (session_id, agent_type, working_dir, title, source, agent_name, trigger_kind, trigger_data, storage_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(session_id) DO UPDATE SET
			   agent_type = excluded.agent_type,
			   working_dir = excluded.working_dir,
			   title = CASE WHEN excluded.title != '' THEN excluded.title ELSE agent_sessions.title END,
			   source = excluded.source,
			   agent_name = excluded.agent_name,
			   trigger_kind = CASE WHEN excluded.trigger_kind != '' THEN excluded.trigger_kind ELSE agent_sessions.trigger_kind END,
			   trigger_data = CASE WHEN excluded.trigger_data != '' THEN excluded.trigger_data ELSE agent_sessions.trigger_data END,
			   storage_id = CASE WHEN excluded.storage_id != '' THEN excluded.storage_id ELSE agent_sessions.storage_id END,
			   updated_at = excluded.updated_at`,
			sessionID, agentType, workingDir, title, source, agentName, triggerKind, triggerData, storageID, now, now,
		)
		return err
	})
}

// GetAgentSession retrieves a single session record.
func (d *DB) GetAgentSession(sessionID string) (*AgentSessionRecord, error) {
	var r AgentSessionRecord
	var archivedAt, pinnedAt sql.NullInt64
	var groupID sql.NullString
	err := d.conn.QueryRow(
		`SELECT session_id, agent_type, working_dir, title, source, agent_name, trigger_kind, trigger_data, storage_id, group_id, pinned_at, created_at, updated_at, archived_at
		 FROM agent_sessions WHERE session_id = ?`,
		sessionID,
	).Scan(&r.SessionID, &r.AgentType, &r.WorkingDir, &r.Title, &r.Source, &r.AgentName, &r.TriggerKind, &r.TriggerData, &r.StorageID, &groupID, &pinnedAt, &r.CreatedAt, &r.UpdatedAt, &archivedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if archivedAt.Valid {
		r.ArchivedAt = &archivedAt.Int64
	}
	if groupID.Valid {
		r.GroupID = &groupID.String
	}
	if pinnedAt.Valid {
		r.PinnedAt = &pinnedAt.Int64
	}
	return &r, nil
}

// ListAgentSessions returns sessions ordered by most recent activity with cursor-based pagination.
// cursor is the updated_at value of the last item from the previous page (0 for first page).
// limit is the max number of results to return (0 for no limit).
func (d *DB) ListAgentSessions(includeArchived bool, cursor int64, limit int) ([]AgentSessionRecord, error) {
	query := `SELECT session_id, agent_type, working_dir, title, source, agent_name, trigger_kind, trigger_data, storage_id, group_id, pinned_at, created_at, updated_at, archived_at
		 FROM agent_sessions`

	var conditions []string
	var args []interface{}
	if !includeArchived {
		conditions = append(conditions, `archived_at IS NULL`)
	}
	if cursor > 0 {
		conditions = append(conditions, `updated_at < ?`)
		args = append(args, cursor)
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

	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []AgentSessionRecord
	for rows.Next() {
		var r AgentSessionRecord
		var archivedAt, pinnedAt sql.NullInt64
		var groupID sql.NullString
		if err := rows.Scan(&r.SessionID, &r.AgentType, &r.WorkingDir, &r.Title, &r.Source, &r.AgentName, &r.TriggerKind, &r.TriggerData, &r.StorageID, &groupID, &pinnedAt, &r.CreatedAt, &r.UpdatedAt, &archivedAt); err != nil {
			return nil, err
		}
		if archivedAt.Valid {
			r.ArchivedAt = &archivedAt.Int64
		}
		if groupID.Valid {
			r.GroupID = &groupID.String
		}
		if pinnedAt.Valid {
			r.PinnedAt = &pinnedAt.Int64
		}
		results = append(results, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return results, nil
}

// UpdateAgentSessionTitle updates the title for a session.
// Does NOT bump updated_at — renaming is metadata, not activity, and shouldn't
// reorder the session in the sidebar.
func (d *DB) UpdateAgentSessionTitle(ctx context.Context, sessionID, title string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`UPDATE agent_sessions SET title = ? WHERE session_id = ?`,
			title, sessionID,
		)
		return err
	})
}

// TouchAgentSession updates the updated_at timestamp.
func (d *DB) TouchAgentSession(ctx context.Context, sessionID string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?`,
			NowMs(), sessionID,
		)
		return err
	})
}

// ── Archive operations ───────────────────────────────────────────────────────

// ArchiveAgentSession marks a session as archived. Does NOT bump updated_at —
// archiving is metadata, not activity.
func (d *DB) ArchiveAgentSession(ctx context.Context, sessionID string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`UPDATE agent_sessions SET archived_at = ? WHERE session_id = ?`,
			NowMs(), sessionID,
		)
		return err
	})
}

// UnarchiveAgentSession removes the archived mark. Does NOT bump updated_at.
func (d *DB) UnarchiveAgentSession(ctx context.Context, sessionID string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`UPDATE agent_sessions SET archived_at = NULL WHERE session_id = ?`,
			sessionID,
		)
		return err
	})
}

// IsAgentSessionArchived checks if a single session is archived
func (d *DB) IsAgentSessionArchived(sessionID string) (bool, error) {
	var exists bool
	err := d.conn.QueryRow(
		`SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE session_id = ? AND archived_at IS NOT NULL)`,
		sessionID,
	).Scan(&exists)
	if err != nil {
		return false, err
	}
	return exists, nil
}

// GetArchivedAgentSessionIDs returns all archived session IDs as a set
func (d *DB) GetArchivedAgentSessionIDs() (map[string]bool, error) {
	rows, err := d.conn.Query(
		`SELECT session_id FROM agent_sessions WHERE archived_at IS NOT NULL`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]bool)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result[id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

// ── Read status operations ───────────────────────────────────────────────────

// MarkAgentSessionRead records the number of result messages (completed turns)
// that were delivered to the user via WebSocket. Uses upsert with MAX so that
// a client disconnecting with a lower count can never regress the value.
func (d *DB) MarkAgentSessionRead(ctx context.Context, sessionID string, resultCount int) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`UPDATE agent_sessions
			 SET last_read_count = MAX(?, last_read_count)
			 WHERE session_id = ?`,
			resultCount, sessionID,
		)
		return err
	})
}

// SessionReadState holds the read status for a single session
type SessionReadState struct {
	SessionID           string
	LastReadResultCount int
}

// GetAllSessionReadStates returns the read state for all sessions as a map.
// Key is session_id, value is last-read result count (completed turns).
func (d *DB) GetAllSessionReadStates() (map[string]int, error) {
	rows, err := d.conn.Query(
		`SELECT session_id, last_read_count FROM agent_sessions WHERE last_read_count > 0`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]int)
	for rows.Next() {
		var s SessionReadState
		if err := rows.Scan(&s.SessionID, &s.LastReadResultCount); err != nil {
			return nil, err
		}
		result[s.SessionID] = s.LastReadResultCount
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

// ── Session preferences (permission mode + always-allowed tools) ─────────────

// SaveAgentSessionPermissionMode persists the permission mode for a session.
// Called when the user changes permission mode via the UI.
func (d *DB) SaveAgentSessionPermissionMode(ctx context.Context, sessionID string, mode string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`UPDATE agent_sessions SET permission_mode = ?, updated_at = ?
			 WHERE session_id = ?`,
			mode, NowMs(), sessionID,
		)
		return err
	})
}

// SaveAgentSessionAllowedTools persists the always-allowed tools list for a session.
// The tools slice is stored as a JSON array.
func (d *DB) SaveAgentSessionAllowedTools(ctx context.Context, sessionID string, tools []string) error {
	toolsJSON, err := json.Marshal(tools)
	if err != nil {
		return err
	}
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`INSERT INTO agent_sessions (session_id, always_allowed_tools, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(session_id) DO UPDATE SET
			   always_allowed_tools = excluded.always_allowed_tools,
			   updated_at = excluded.updated_at`,
			sessionID, string(toolsJSON), NowMs(),
		)
		return err
	})
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
func (d *DB) GetAllAgentSessionPreferences() (map[string]*AgentSessionPreferences, error) {
	rows, err := d.conn.Query(
		`SELECT session_id, permission_mode, always_allowed_tools
		 FROM agent_sessions
		 WHERE permission_mode != '' OR always_allowed_tools != '[]'`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]*AgentSessionPreferences)
	for rows.Next() {
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
		result[p.SessionID] = &p
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

// GetAgentSessionPermissionMode returns the permission_mode for a single session.
// Returns "" if the session doesn't exist or has no permission mode set.
func (d *DB) GetAgentSessionPermissionMode(sessionID string) (string, error) {
	var mode string
	err := d.conn.QueryRow(
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
func (d *DB) ShareAgentSession(ctx context.Context, sessionID, shareToken string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`INSERT INTO agent_sessions (session_id, share_token, shared_at, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(session_id) DO UPDATE SET
			   share_token = excluded.share_token,
			   shared_at = excluded.shared_at,
			   updated_at = excluded.updated_at`,
			sessionID, shareToken, NowMs(), NowMs(),
		)
		return err
	})
}

// UnshareAgentSession removes the share token from a session.
func (d *DB) UnshareAgentSession(ctx context.Context, sessionID string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`UPDATE agent_sessions SET share_token = NULL, shared_at = NULL, updated_at = ?
			 WHERE session_id = ?`,
			NowMs(), sessionID,
		)
		return err
	})
}

// GetSessionIDByShareToken resolves a share token to a session ID.
// Returns "" if the token is not found.
func (d *DB) GetSessionIDByShareToken(shareToken string) (string, error) {
	var sessionID string
	err := d.conn.QueryRow(
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
func (d *DB) GetShareToken(sessionID string) (string, error) {
	var token sql.NullString
	err := d.conn.QueryRow(
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
func (d *DB) GetAllShareTokens() (map[string]string, error) {
	rows, err := d.conn.Query(
		`SELECT session_id, share_token FROM agent_sessions WHERE share_token IS NOT NULL`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var e ShareTokenEntry
		if err := rows.Scan(&e.SessionID, &e.ShareToken); err != nil {
			return nil, err
		}
		result[e.SessionID] = e.ShareToken
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
