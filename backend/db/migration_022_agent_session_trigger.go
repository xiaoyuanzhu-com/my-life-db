package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     22,
		Description: "Add trigger_kind and trigger_data columns to agent_sessions for per-run trigger context",
		Target:      DBRoleApp,
		Up: func(db *sql.DB) error {
			tx, err := db.Begin()
			if err != nil {
				return err
			}
			defer tx.Rollback()

			if _, err := tx.Exec(`ALTER TABLE agent_sessions ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
			if _, err := tx.Exec(`ALTER TABLE agent_sessions ADD COLUMN trigger_data TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
			return tx.Commit()
		},
	})
}
