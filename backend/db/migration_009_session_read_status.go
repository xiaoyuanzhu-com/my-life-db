package db

import (
	"database/sql"
)

func init() {
	RegisterMigration(Migration{
		Version:     9,
		Description: "Add session_read_status table for cross-device unread tracking",
		Up:          migration009_sessionReadStatus,
	})
}

func migration009_sessionReadStatus(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS session_read_status (
			session_id              TEXT PRIMARY KEY,
			last_read_message_count INTEGER NOT NULL DEFAULT 0,
			updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`)
	return err
}
