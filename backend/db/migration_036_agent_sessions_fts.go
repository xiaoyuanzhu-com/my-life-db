package db

import (
	"database/sql"
	"fmt"
)

func init() {
	RegisterMigration(Migration{
		Version:     36,
		Description: "Add agent_sessions_fts (FTS5) + agent_sessions_index_state for session-text search",
		Target:      DBRoleIndex,
		Up:          migration036Up,
	})
}

// migration036Up creates the session-text search index. Per design discussion:
//   - One FTS row per session (whole-transcript blob, not per-turn).
//   - simple tokenizer with English + Chinese (jieba) — same as files_fts.
//   - A side table tracks the last-indexed timestamp so a periodic sweep can
//     re-index only sessions whose last_message_at moved forward.
func migration036Up(db *sql.DB) error {
	stmts := []string{
		`CREATE VIRTUAL TABLE IF NOT EXISTS agent_sessions_fts USING fts5(
			session_id UNINDEXED,
			content,
			tokenize = 'simple 0'
		)`,
		`CREATE TABLE IF NOT EXISTS agent_sessions_index_state (
			session_id       TEXT PRIMARY KEY,
			last_indexed_at  INTEGER NOT NULL
		)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			snippet := s
			if len(snippet) > 60 {
				snippet = snippet[:60]
			}
			return fmt.Errorf("migration036: exec %q: %w", snippet, err)
		}
	}
	return nil
}
