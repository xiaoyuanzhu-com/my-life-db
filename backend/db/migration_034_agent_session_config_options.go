package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     34,
		Description: "Add config_options JSON map to agent_sessions for per-session model/etc preferences",
		Target:      DBRoleApp,
		Up: func(db *sql.DB) error {
			_, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN config_options TEXT NOT NULL DEFAULT '{}'`)
			return err
		},
	})
}
