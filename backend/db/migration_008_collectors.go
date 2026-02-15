package db

import (
	"database/sql"
)

func init() {
	RegisterMigration(Migration{
		Version:     8,
		Description: "Add collectors table for data collector configuration",
		Up:          migration008_collectors,
	})
}

func migration008_collectors(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS collectors (
			id         TEXT PRIMARY KEY,
			enabled    INTEGER NOT NULL DEFAULT 0,
			config     TEXT,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`)
	return err
}
