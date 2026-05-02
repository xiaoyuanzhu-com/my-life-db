package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     23,
		Description: "Add storage_id column to agent_sessions for the per-session files folder",
		Target:      DBRoleApp,
		Up: func(db *sql.DB) error {
			_, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN storage_id TEXT NOT NULL DEFAULT ''`)
			return err
		},
	})
}
