package db

import (
	"database/sql"
)

func init() {
	RegisterMigration(Migration{
		Version:     12,
		Description: "Consolidate claude session tables into unified claude_sessions",
		Up:          migration012_claudeSessions,
	})
}

func migration012_claudeSessions(db *sql.DB) error {
	// Create the unified table
	if _, err := db.Exec(`
		CREATE TABLE claude_sessions (
			session_id           TEXT PRIMARY KEY,
			archived_at          INTEGER,
			last_read_count      INTEGER NOT NULL DEFAULT 0,
			permission_mode      TEXT NOT NULL DEFAULT '',
			always_allowed_tools TEXT NOT NULL DEFAULT '[]',
			updated_at           INTEGER NOT NULL DEFAULT 0
		)
	`); err != nil {
		return err
	}

	// Migrate archived sessions
	if _, err := db.Exec(`
		INSERT INTO claude_sessions (session_id, archived_at, updated_at)
		SELECT session_id, hidden_at, hidden_at
		FROM archived_claude_sessions
	`); err != nil {
		return err
	}

	// Migrate read status (merge with ON CONFLICT for sessions that are both archived and have read state)
	if _, err := db.Exec(`
		INSERT INTO claude_sessions (session_id, last_read_count, updated_at)
		SELECT session_id, last_read_message_count, updated_at
		FROM session_read_status
		ON CONFLICT(session_id) DO UPDATE SET
			last_read_count = excluded.last_read_count,
			updated_at = MAX(claude_sessions.updated_at, excluded.updated_at)
	`); err != nil {
		return err
	}

	// Drop old tables (IF EXISTS for safety)
	if _, err := db.Exec(`DROP TABLE IF EXISTS archived_claude_sessions`); err != nil {
		return err
	}
	if _, err := db.Exec(`DROP TABLE IF EXISTS session_read_status`); err != nil {
		return err
	}

	return nil
}
