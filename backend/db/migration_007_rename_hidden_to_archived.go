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
	_, err := db.Exec(`
		ALTER TABLE hidden_claude_sessions RENAME TO archived_claude_sessions;
	`)
	return err
}
