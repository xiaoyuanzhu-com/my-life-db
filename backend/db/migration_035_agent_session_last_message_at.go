package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     35,
		Description: "Add last_message_at to agent_sessions; drives the session-search FTS sweep",
		Target:      DBRoleApp,
		Up: func(db *sql.DB) error {
			if _, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN last_message_at INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
			// Backfill: existing sessions get their updated_at as a starting point so
			// the first sweep picks them up once. New activity then drives further
			// updates via SetPromptInFlight / ClearPromptInFlight.
			if _, err := db.Exec(`UPDATE agent_sessions SET last_message_at = updated_at WHERE last_message_at = 0`); err != nil {
				return err
			}
			return nil
		},
	})
}
