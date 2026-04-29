package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     25,
		Description: "Add group_id and pinned_at columns to agent_sessions",
		Up: func(db *sql.DB) error {
			if _, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN group_id TEXT`); err != nil {
				return err
			}
			if _, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN pinned_at INTEGER`); err != nil {
				return err
			}
			if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_agent_sessions_group ON agent_sessions(group_id)`); err != nil {
				return err
			}
			if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_agent_sessions_pinned ON agent_sessions(pinned_at)`); err != nil {
				return err
			}
			return nil
		},
	})
}
