package db

import (
	"database/sql"
)

func init() {
	RegisterMigration(Migration{
		Version:     4,
		Description: "Add sessions table for password authentication",
		Up:          migration004_sessions,
	})
}

func migration004_sessions(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			last_used_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
	`)
	return err
}
