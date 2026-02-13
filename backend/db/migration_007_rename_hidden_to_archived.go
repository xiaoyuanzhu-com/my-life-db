package db

import (
	"database/sql"
)

func init() {
	RegisterMigration(Migration{
		Version:     7,
		Description: "Rename hidden_claude_sessions to archived_claude_sessions",
		Up:          migration007_renameHiddenToArchived,
	})
}

func migration007_renameHiddenToArchived(db *sql.DB) error {
	// Check if already renamed (idempotent for re-runs)
	var archivedExists bool
	if err := db.QueryRow(`
		SELECT COUNT(*) > 0 FROM sqlite_master
		WHERE type='table' AND name='archived_claude_sessions'
	`).Scan(&archivedExists); err != nil {
		return err
	}
	if archivedExists {
		// Already done — drop the old table if it still lingers
		db.Exec(`DROP TABLE IF EXISTS hidden_claude_sessions`)
		return nil
	}

	// Check if source table exists
	var hiddenExists bool
	if err := db.QueryRow(`
		SELECT COUNT(*) > 0 FROM sqlite_master
		WHERE type='table' AND name='hidden_claude_sessions'
	`).Scan(&hiddenExists); err != nil {
		return err
	}
	if !hiddenExists {
		// Neither table exists — create the target directly
		_, err := db.Exec(`
			CREATE TABLE archived_claude_sessions (
				session_id TEXT PRIMARY KEY,
				hidden_at TEXT NOT NULL
			)
		`)
		return err
	}

	_, err := db.Exec(`ALTER TABLE hidden_claude_sessions RENAME TO archived_claude_sessions`)
	return err
}
