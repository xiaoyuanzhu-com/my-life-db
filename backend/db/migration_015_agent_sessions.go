package db

import (
	"database/sql"
)

func init() {
	RegisterMigration(Migration{
		Version:     15,
		Description: "Rename claude_sessions to agent_sessions, add agent_type column",
		Target:      DBRoleApp,
		Up: func(db *sql.DB) error {
			tx, err := db.Begin()
			if err != nil {
				return err
			}
			defer tx.Rollback()

			// Create new table with agent_type column
			if _, err := tx.Exec(`
				CREATE TABLE IF NOT EXISTS agent_sessions (
					session_id           TEXT PRIMARY KEY,
					agent_type           TEXT NOT NULL DEFAULT 'claude_code',
					archived_at          INTEGER,
					last_read_count      INTEGER NOT NULL DEFAULT 0,
					permission_mode      TEXT NOT NULL DEFAULT '',
					always_allowed_tools TEXT NOT NULL DEFAULT '[]',
					updated_at           INTEGER NOT NULL DEFAULT 0,
					share_token          TEXT,
					shared_at            INTEGER
				)
			`); err != nil {
				return err
			}

			// Migrate data from claude_sessions (if it exists)
			var tableExists int
			err = tx.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='claude_sessions'`).Scan(&tableExists)
			if err != nil {
				return err
			}

			if tableExists > 0 {
				if _, err := tx.Exec(`
					INSERT OR IGNORE INTO agent_sessions
						(session_id, agent_type, archived_at, last_read_count,
						 permission_mode, always_allowed_tools, updated_at,
						 share_token, shared_at)
					SELECT
						session_id, 'claude_code', archived_at, last_read_count,
						permission_mode, always_allowed_tools, updated_at,
						share_token, shared_at
					FROM claude_sessions
				`); err != nil {
					return err
				}

				// Drop old table
				if _, err := tx.Exec(`DROP TABLE claude_sessions`); err != nil {
					return err
				}
			}

			// Create index for share tokens
			if _, err := tx.Exec(`
				CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_share_token
				ON agent_sessions(share_token)
			`); err != nil {
				return err
			}

			return tx.Commit()
		},
	})
}
