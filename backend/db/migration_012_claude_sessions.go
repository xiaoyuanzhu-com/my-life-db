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

func migration012_claudeSessions(database *sql.DB) error {
	tx, err := database.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Create the unified table (IF NOT EXISTS for idempotency after partial failure)
	if _, err := tx.Exec(`
		CREATE TABLE IF NOT EXISTS claude_sessions (
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

	// Migrate archived sessions (IGNORE if already migrated from a partial run)
	if _, err := tx.Exec(`
		INSERT OR IGNORE INTO claude_sessions (session_id, archived_at, updated_at)
		SELECT session_id, hidden_at, hidden_at
		FROM archived_claude_sessions
	`); err != nil {
		return err
	}

	// Migrate read status: first insert sessions that don't exist yet
	if _, err := tx.Exec(`
		INSERT OR IGNORE INTO claude_sessions (session_id, last_read_count, updated_at)
		SELECT session_id, last_read_message_count, updated_at
		FROM session_read_status
	`); err != nil {
		return err
	}

	// Then update sessions that already existed (from archived_claude_sessions) with read status
	if _, err := tx.Exec(`
		UPDATE claude_sessions
		SET last_read_count = (SELECT last_read_message_count FROM session_read_status WHERE session_id = claude_sessions.session_id),
		    updated_at = MAX(claude_sessions.updated_at, (SELECT updated_at FROM session_read_status WHERE session_id = claude_sessions.session_id))
		WHERE session_id IN (SELECT session_id FROM session_read_status)
	`); err != nil {
		return err
	}

	// Drop old tables
	if _, err := tx.Exec(`DROP TABLE IF EXISTS archived_claude_sessions`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DROP TABLE IF EXISTS session_read_status`); err != nil {
		return err
	}

	return tx.Commit()
}
