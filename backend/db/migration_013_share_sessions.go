package db

import (
	"database/sql"
)

func init() {
	RegisterMigration(Migration{
		Version:     13,
		Description: "Add share_token and shared_at columns to claude_sessions",
		Up:          migration013_shareSessions,
		Target:      DBRoleApp,
	})
}

func migration013_shareSessions(database *sql.DB) error {
	tx, err := database.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`ALTER TABLE claude_sessions ADD COLUMN share_token TEXT`); err != nil {
		return err
	}

	if _, err := tx.Exec(`ALTER TABLE claude_sessions ADD COLUMN shared_at INTEGER`); err != nil {
		return err
	}

	if _, err := tx.Exec(`CREATE UNIQUE INDEX idx_claude_sessions_share_token ON claude_sessions(share_token)`); err != nil {
		return err
	}

	return tx.Commit()
}
