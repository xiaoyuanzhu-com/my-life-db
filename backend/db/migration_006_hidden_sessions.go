package db

import (
	"database/sql"
)

func init() {
	RegisterMigration(Migration{
		Version:     6,
		Description: "Add hidden Claude sessions table",
		Up:          migration006_hiddenSessions,
	})
}

func migration006_hiddenSessions(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS hidden_claude_sessions (
			session_id TEXT PRIMARY KEY,
			hidden_at TEXT NOT NULL
		);
	`)
	return err
}
