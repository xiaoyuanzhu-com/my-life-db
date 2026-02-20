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
	// Check if the sessions table already exists (Node.js legacy uses "token" as PK).
	var exists bool
	if err := db.QueryRow(`
		SELECT COUNT(*) > 0 FROM sqlite_master
		WHERE type='table' AND name='sessions'
	`).Scan(&exists); err != nil {
		return err
	}

	if !exists {
		_, err := db.Exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				last_used_at TEXT NOT NULL
			);
			CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
		`)
		return err
	}

	// Table exists — check if PK column is "token" (Node.js legacy) and rename to "id".
	hasToken := false
	rows, err := db.Query(`PRAGMA table_info(sessions)`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull int
		var dfltValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err != nil {
			rows.Close()
			return err
		}
		if name == "token" {
			hasToken = true
		}
	}
	rows.Close()

	if hasToken {
		_, err := db.Exec(`
			CREATE TABLE sessions_new (
				id TEXT PRIMARY KEY,
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				last_used_at TEXT NOT NULL
			);
			INSERT INTO sessions_new SELECT token, created_at, expires_at, last_used_at FROM sessions;
			DROP TABLE sessions;
			ALTER TABLE sessions_new RENAME TO sessions;
			CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
		`)
		return err
	}

	return nil
}
