package db

import (
	"database/sql"
)

func init() {
	RegisterMigration(Migration{
		Version:     16,
		Description: "Add working_dir, title, created_at to agent_sessions for session resume and display",
		Up: func(db *sql.DB) error {
			tx, err := db.Begin()
			if err != nil {
				return err
			}
			defer tx.Rollback()

			// Add working_dir — needed by ACP session/load to find JSONL files
			if _, err := tx.Exec(`ALTER TABLE agent_sessions ADD COLUMN working_dir TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}

			// Add title — display name in session list
			if _, err := tx.Exec(`ALTER TABLE agent_sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}

			// Add created_at — when session was first created
			if _, err := tx.Exec(`ALTER TABLE agent_sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}

			return tx.Commit()
		},
	})
}
