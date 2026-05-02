package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"
)

// AgentSessionGroupRecord represents a single group row.
type AgentSessionGroupRecord struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	SortOrder int    `json:"sortOrder"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

// CreateAgentSessionGroup inserts a new group, appending it after the current
// max sort_order. Returns the created record.
func (d *DB) CreateAgentSessionGroup(ctx context.Context, name string) (*AgentSessionGroupRecord, error) {
	id := uuid.New().String()
	now := NowMs()

	// Find current max sort_order; default to 0.
	var maxOrder sql.NullInt64
	if err := d.conn.QueryRow(`SELECT MAX(sort_order) FROM agent_session_groups`).Scan(&maxOrder); err != nil {
		return nil, err
	}
	next := 0
	if maxOrder.Valid {
		next = int(maxOrder.Int64) + 1
	}

	if err := d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`INSERT INTO agent_session_groups (id, name, sort_order, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)`,
			id, name, next, now, now,
		)
		return err
	}); err != nil {
		return nil, err
	}

	return &AgentSessionGroupRecord{
		ID:        id,
		Name:      name,
		SortOrder: next,
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

// ListAgentSessionGroups returns all groups ordered by sort_order ASC.
func (d *DB) ListAgentSessionGroups() ([]AgentSessionGroupRecord, error) {
	rows, err := d.conn.Query(
		`SELECT id, name, sort_order, created_at, updated_at
		 FROM agent_session_groups
		 ORDER BY sort_order ASC, created_at ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var groups []AgentSessionGroupRecord
	for rows.Next() {
		var g AgentSessionGroupRecord
		if err := rows.Scan(&g.ID, &g.Name, &g.SortOrder, &g.CreatedAt, &g.UpdatedAt); err != nil {
			return nil, err
		}
		groups = append(groups, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return groups, nil
}

// GetAgentSessionGroup fetches a single group by ID. Returns nil if not found.
func (d *DB) GetAgentSessionGroup(id string) (*AgentSessionGroupRecord, error) {
	var g AgentSessionGroupRecord
	err := d.conn.QueryRow(
		`SELECT id, name, sort_order, created_at, updated_at FROM agent_session_groups WHERE id = ?`,
		id,
	).Scan(&g.ID, &g.Name, &g.SortOrder, &g.CreatedAt, &g.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// RenameAgentSessionGroup updates the name of a group.
func (d *DB) RenameAgentSessionGroup(ctx context.Context, id, name string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`UPDATE agent_session_groups SET name = ?, updated_at = ? WHERE id = ?`,
			name, NowMs(), id,
		)
		return err
	})
}

// DeleteAgentSessionGroup deletes a group. Sessions previously in the group
// have their group_id cleared (NULL) so they appear in the ungrouped section.
func (d *DB) DeleteAgentSessionGroup(ctx context.Context, id string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`UPDATE agent_sessions SET group_id = NULL WHERE group_id = ?`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM agent_session_groups WHERE id = ?`, id); err != nil {
			return err
		}
		return nil
	})
}

// ReorderAgentSessionGroups assigns sort_order = 0..N-1 in the given ID order.
// IDs not present in the input are left at their current sort_order (which will
// likely sort below the explicit list since explicit values start at 0). To get
// a clean ordering, callers should pass the full list of group IDs.
func (d *DB) ReorderAgentSessionGroups(ctx context.Context, orderedIDs []string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		now := NowMs()
		for i, id := range orderedIDs {
			if _, err := tx.Exec(
				`UPDATE agent_session_groups SET sort_order = ?, updated_at = ? WHERE id = ?`,
				i, now, id,
			); err != nil {
				return fmt.Errorf("reorder group %s: %w", id, err)
			}
		}
		return nil
	})
}

// ── Session-side group / pin operations ──────────────────────────────────────

// SetAgentSessionGroup assigns a session to a group, or clears the assignment
// when groupID is "". The caller is expected to pre-validate that groupID
// (when non-empty) refers to an existing group.
//
// Does NOT bump updated_at — moving a session between groups is metadata,
// not activity, and shouldn't reorder it in the sidebar.
func (d *DB) SetAgentSessionGroup(ctx context.Context, sessionID, groupID string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		if groupID == "" {
			_, err := tx.Exec(
				`UPDATE agent_sessions SET group_id = NULL WHERE session_id = ?`,
				sessionID,
			)
			return err
		}
		_, err := tx.Exec(
			`UPDATE agent_sessions SET group_id = ? WHERE session_id = ?`,
			groupID, sessionID,
		)
		return err
	})
}

// SetAgentSessionPinned pins (now) or unpins (NULL) a session.
// Does NOT bump updated_at — pinning is metadata, not activity.
func (d *DB) SetAgentSessionPinned(ctx context.Context, sessionID string, pinned bool) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		if !pinned {
			_, err := tx.Exec(
				`UPDATE agent_sessions SET pinned_at = NULL WHERE session_id = ?`,
				sessionID,
			)
			return err
		}
		_, err := tx.Exec(
			`UPDATE agent_sessions SET pinned_at = ? WHERE session_id = ?`,
			NowMs(), sessionID,
		)
		return err
	})
}
