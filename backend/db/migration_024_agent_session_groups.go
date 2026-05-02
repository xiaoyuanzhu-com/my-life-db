package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     24,
		Description: "Create agent_session_groups table for grouping agent sessions",
		Target:      DBRoleApp,
		Up: func(db *sql.DB) error {
			_, err := db.Exec(`
				CREATE TABLE IF NOT EXISTS agent_session_groups (
					id         TEXT PRIMARY KEY,
					name       TEXT NOT NULL,
					sort_order INTEGER NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`)
			if err != nil {
				return err
			}
			_, err = db.Exec(`CREATE INDEX IF NOT EXISTS idx_agent_session_groups_sort ON agent_session_groups(sort_order)`)
			return err
		},
	})
}
