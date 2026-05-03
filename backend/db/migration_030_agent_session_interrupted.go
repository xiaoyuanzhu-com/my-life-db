package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     30,
		Description: "Add interrupted-state columns to agent_sessions",
		Target:      DBRoleApp,
		Up: func(db *sql.DB) error {
			if _, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN last_prompt_text TEXT`); err != nil {
				return err
			}
			if _, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN last_prompt_at INTEGER`); err != nil {
				return err
			}
			if _, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN is_processing INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
			if _, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN interrupted_at INTEGER`); err != nil {
				return err
			}
			return nil
		},
	})
}
