package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// agent_sessions_fts is a SQLite FTS5 virtual table that stores one row per
// agent session — the entire transcript text concatenated into a single blob.
// agent_sessions_index_state tracks the last-indexed timestamp per session so
// the periodic sweep (workers/sessionindex) can skip sessions whose
// last_message_at hasn't moved.
//
// Both live in the index DB, mirroring the files_fts pattern.

// AgentSessionFTSHit is a single result row from SearchAgentSessionsFTS.
type AgentSessionFTSHit struct {
	SessionID string
	Snippet   string  // simple_snippet output with <em>...</em> markup
	Score     float64 // bm25 score (lower is better)
}

// AgentSessionFTSSearchOptions controls SearchAgentSessionsFTS pagination.
type AgentSessionFTSSearchOptions struct {
	Limit  int
	Offset int
}

// IndexAgentSession upserts a row into agent_sessions_fts and records the
// last-indexed timestamp. Both writes happen inside a single transaction so
// the index state can never get ahead of the FTS row.
func (d *DB) IndexAgentSession(ctx context.Context, sessionID, content string, indexedAt int64) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`DELETE FROM agent_sessions_fts WHERE session_id = ?`, sessionID); err != nil {
			return fmt.Errorf("delete existing session fts row: %w", err)
		}
		if _, err := tx.Exec(
			`INSERT INTO agent_sessions_fts(session_id, content) VALUES (?, ?)`,
			sessionID, content,
		); err != nil {
			return fmt.Errorf("insert session fts row: %w", err)
		}
		if _, err := tx.Exec(
			`INSERT INTO agent_sessions_index_state(session_id, last_indexed_at) VALUES (?, ?)
			 ON CONFLICT(session_id) DO UPDATE SET last_indexed_at = excluded.last_indexed_at`,
			sessionID, indexedAt,
		); err != nil {
			return fmt.Errorf("upsert session index state: %w", err)
		}
		return nil
	})
}

// DeleteAgentSessionFromIndex removes a session from both FTS and state.
func (d *DB) DeleteAgentSessionFromIndex(ctx context.Context, sessionID string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`DELETE FROM agent_sessions_fts WHERE session_id = ?`, sessionID); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM agent_sessions_index_state WHERE session_id = ?`, sessionID); err != nil {
			return err
		}
		return nil
	})
}

// GetAllAgentSessionIndexState returns sessionID -> last_indexed_at for every
// row in agent_sessions_index_state. Used by the sweep to compare against
// agent_sessions.last_message_at and decide which sessions need re-indexing.
func (d *DB) GetAllAgentSessionIndexState() (map[string]int64, error) {
	rows, err := d.conn.Query(`SELECT session_id, last_indexed_at FROM agent_sessions_index_state`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string]int64)
	for rows.Next() {
		var id string
		var ts int64
		if err := rows.Scan(&id, &ts); err != nil {
			return nil, err
		}
		out[id] = ts
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// SearchAgentSessionsFTS runs a full-text query against agent_sessions_fts.
// Returns ranked hits with <em>...</em> highlight markup on the snippet.
//
// The query is wrapped in simple_query() so freeform user input (English or
// Chinese) works without learning FTS5 syntax. Snippet length is fixed at 64
// tokens to match the files_fts behaviour.
func (d *DB) SearchAgentSessionsFTS(query string, opts AgentSessionFTSSearchOptions) ([]AgentSessionFTSHit, int, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 20
	}
	offset := opts.Offset
	if offset < 0 {
		offset = 0
	}

	whereSQL := `agent_sessions_fts MATCH simple_query(?)`
	args := []any{query}

	var total int
	if err := d.conn.QueryRow(
		`SELECT COUNT(*) FROM agent_sessions_fts WHERE `+whereSQL,
		args...,
	).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count session fts hits: %w", err)
	}

	pageSQL := `
		SELECT
			session_id,
			simple_snippet(agent_sessions_fts, 1, '<em>', '</em>', '...', 64) AS snippet,
			bm25(agent_sessions_fts) AS score
		FROM agent_sessions_fts
		WHERE ` + whereSQL + `
		ORDER BY score
		LIMIT ? OFFSET ?`
	pageArgs := append(append([]any{}, args...), limit, offset)

	rows, err := d.conn.Query(pageSQL, pageArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("query session fts: %w", err)
	}
	defer rows.Close()

	var hits []AgentSessionFTSHit
	for rows.Next() {
		var h AgentSessionFTSHit
		if err := rows.Scan(&h.SessionID, &h.Snippet, &h.Score); err != nil {
			return nil, 0, fmt.Errorf("scan session fts row: %w", err)
		}
		hits = append(hits, h)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return hits, total, nil
}

// HasContentHit is a small helper for callers that want to know if the snippet
// actually matched anything (a row with no in-snippet match still gets
// returned by FTS5 in some edge cases — but here, since we MATCH against
// content, every row has a hit).
func (h AgentSessionFTSHit) HasContentHit() bool {
	return strings.Contains(h.Snippet, "<em>")
}
