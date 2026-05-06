package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     33,
		Description: "Add result_count column to agent_sessions for cross-restart unread tracking",
		Target:      DBRoleApp,
		Up: func(db *sql.DB) error {
			_, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN result_count INTEGER NOT NULL DEFAULT 0`)
			return err
		},
	})
}
