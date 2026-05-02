package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     21,
		Description: "Rename agent_sessions.agent_file to agent_name and strip .md suffix from existing values",
		Target:      DBRoleApp,
		Up: func(db *sql.DB) error {
			tx, err := db.Begin()
			if err != nil {
				return err
			}
			defer tx.Rollback()

			if _, err := tx.Exec(`ALTER TABLE agent_sessions RENAME COLUMN agent_file TO agent_name`); err != nil {
				return err
			}

			if _, err := tx.Exec(`
				UPDATE agent_sessions
				SET agent_name = substr(agent_name, 1, length(agent_name) - 3)
				WHERE agent_name LIKE '%.md'
			`); err != nil {
				return err
			}

			return tx.Commit()
		},
	})
}
