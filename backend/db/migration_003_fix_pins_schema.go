package db

import (
	"database/sql"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

func init() {
	RegisterMigration(Migration{
		Version:     3,
		Description: "Fix pins table schema - add id, file_path, and pinned_at columns",
		Up:          migration003_fixPinsSchema,
	})
}

func migration003_fixPinsSchema(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Check if pins table has the old schema (path, created_at)
	var hasPath bool
	err = tx.QueryRow(`
		SELECT COUNT(*) > 0
		FROM pragma_table_info('pins')
		WHERE name='path'
	`).Scan(&hasPath)
	if err != nil {
		return err
	}

	var hasFilePath bool
	err = tx.QueryRow(`
		SELECT COUNT(*) > 0
		FROM pragma_table_info('pins')
		WHERE name='file_path'
	`).Scan(&hasFilePath)
	if err != nil {
		return err
	}

	// If we have 'path' but not 'file_path', we need to migrate
	if hasPath && !hasFilePath {
		log.Info().Msg("migrating pins table to include id, file_path, and pinned_at")

		// Create new pins table with correct schema
		_, err = tx.Exec(`
			CREATE TABLE pins_new (
				id TEXT PRIMARY KEY,
				file_path TEXT NOT NULL UNIQUE,
				pinned_at TEXT NOT NULL,
				created_at TEXT NOT NULL
			);

			CREATE INDEX idx_pins_new_file_path ON pins_new(file_path);
			CREATE INDEX idx_pins_new_pinned_at ON pins_new(pinned_at DESC);
		`)
		if err != nil {
			return err
		}

		// Copy data from old schema to new schema
		// Generate UUIDs for existing pins, use created_at as pinned_at
		_, err = tx.Exec(`
			INSERT INTO pins_new (id, file_path, pinned_at, created_at)
			SELECT
				lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))) as id,
				path as file_path,
				created_at as pinned_at,
				created_at
			FROM pins
		`)
		if err != nil {
			return err
		}

		// Drop old table and indexes
		_, err = tx.Exec(`
			DROP INDEX IF EXISTS idx_pins_created_at;
			DROP TABLE pins;
		`)
		if err != nil {
			return err
		}

		// Rename new table
		_, err = tx.Exec(`
			ALTER TABLE pins_new RENAME TO pins;
		`)
		if err != nil {
			return err
		}

		log.Info().Msg("pins table migration complete")
	} else if !hasPath && hasFilePath {
		// Already has the new schema, nothing to do
		log.Info().Msg("pins table already has correct schema")
	} else {
		log.Info().Msg("pins table schema check complete")
	}

	return tx.Commit()
}
