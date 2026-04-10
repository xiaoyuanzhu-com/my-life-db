package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     20,
		Description: "Add source and agent_file columns to agent_sessions",
		Up: func(db *sql.DB) error {
			_, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`)
			if err != nil {
				return err
			}
			_, err = db.Exec(`ALTER TABLE agent_sessions ADD COLUMN agent_file TEXT NOT NULL DEFAULT ''`)
			return err
		},
	})
}
