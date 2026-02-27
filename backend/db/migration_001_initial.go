package db

import (
	"database/sql"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

func init() {
	RegisterMigration(Migration{
		Version:     1,
		Description: "Initial schema - create or upgrade from Node.js backend",
		Up:          migration001_initial,
	})
}

func migration001_initial(db *sql.DB) error {
	// Check if this is an existing Node.js database (version 38)
	// by checking for the files table which was created in Node.js migration 18
	var tableExists bool
	err := db.QueryRow(`
		SELECT COUNT(*) > 0
		FROM sqlite_master
		WHERE type='table' AND name='files'
	`).Scan(&tableExists)
	if err != nil {
		return err
	}

	if tableExists {
		log.Info().Msg("detected existing database, applying compatibility updates")
		return upgradeFromNodeJS(db)
	}

	log.Info().Msg("fresh install, creating initial schema")
	return createFreshSchema(db)
}

// createFreshSchema creates all tables for a fresh installation
func createFreshSchema(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Files table
	_, err = tx.Exec(`
		CREATE TABLE files (
			path TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			is_folder INTEGER NOT NULL DEFAULT 0,
			size INTEGER,
			mime_type TEXT,
			hash TEXT,
			modified_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_scanned_at TEXT,
			text_preview TEXT,
			preview_sqlar TEXT
		);

		CREATE INDEX idx_files_path_prefix ON files(path);
		CREATE INDEX idx_files_is_folder ON files(is_folder);
		CREATE INDEX idx_files_modified_at ON files(modified_at);
		CREATE INDEX idx_files_created_at ON files(created_at);
	`)
	if err != nil {
		return err
	}

	// Digests table (with UNIQUE constraint on file_path + digester)
	_, err = tx.Exec(`
		CREATE TABLE digests (
			id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL,
			digester TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'todo',
			content TEXT,
			sqlar_name TEXT,
			error TEXT,
			attempts INTEGER DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(file_path, digester)
		);

		CREATE INDEX idx_digests_file_path ON digests(file_path);
		CREATE INDEX idx_digests_digester ON digests(digester);
		CREATE INDEX idx_digests_status ON digests(status);
	`)
	if err != nil {
		return err
	}

	// Settings table
	_, err = tx.Exec(`
		CREATE TABLE settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TRIGGER settings_updated_at
		AFTER UPDATE ON settings
		BEGIN
			UPDATE settings SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
		END;
	`)
	if err != nil {
		return err
	}

	// Pins table (simplified Go schema)
	_, err = tx.Exec(`
		CREATE TABLE pins (
			path TEXT PRIMARY KEY,
			created_at TEXT NOT NULL
		);

		CREATE INDEX idx_pins_created_at ON pins(created_at DESC);
	`)
	if err != nil {
		return err
	}

	// SQLite Archive table
	_, err = tx.Exec(`
		CREATE TABLE sqlar (
			name TEXT PRIMARY KEY,
			mode INT,
			mtime INT,
			sz INT,
			data BLOB
		)
	`)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// upgradeFromNodeJS applies compatibility updates for existing Node.js databases
func upgradeFromNodeJS(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Check if digests table has UNIQUE constraint on (file_path, digester)
	// Node.js migrations didn't add this, but Go backend expects it
	var hasConstraint bool
	err = tx.QueryRow(`
		SELECT COUNT(*) > 0
		FROM sqlite_master
		WHERE type='index' AND tbl_name='digests' AND name LIKE '%file_path%digester%'
	`).Scan(&hasConstraint)
	if err != nil {
		return err
	}

	if !hasConstraint {
		log.Info().Msg("adding UNIQUE constraint to digests table")
		// SQLite doesn't support ADD CONSTRAINT, so recreate the table
		_, err = tx.Exec(`
			-- Create new digests table with constraint
			CREATE TABLE digests_new (
				id TEXT PRIMARY KEY,
				file_path TEXT NOT NULL,
				digester TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'todo',
				content TEXT,
				sqlar_name TEXT,
				error TEXT,
				attempts INTEGER DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE(file_path, digester)
			);

			-- Copy data (use INSERT OR IGNORE to handle any duplicates)
			INSERT OR IGNORE INTO digests_new
			SELECT id, file_path, digester, status, content, sqlar_name, error, attempts, created_at, updated_at
			FROM digests;

			-- Drop old table and indexes
			DROP INDEX IF EXISTS idx_digests_file_path;
			DROP INDEX IF EXISTS idx_digests_digester;
			DROP INDEX IF EXISTS idx_digests_status;
			DROP TABLE digests;

			-- Rename new table
			ALTER TABLE digests_new RENAME TO digests;

			-- Recreate indexes
			CREATE INDEX idx_digests_file_path ON digests(file_path);
			CREATE INDEX idx_digests_digester ON digests(digester);
			CREATE INDEX idx_digests_status ON digests(status);
		`)
		if err != nil {
			return err
		}
	}

	// Check if pins table uses old Node.js schema (id, file_path) vs Go schema (path)
	var oldPinsSchema bool
	err = tx.QueryRow(`
		SELECT COUNT(*) > 0
		FROM pragma_table_info('pins')
		WHERE name='file_path'
	`).Scan(&oldPinsSchema)
	if err != nil {
		return err
	}

	if oldPinsSchema {
		log.Info().Msg("migrating pins table to new schema")
		_, err = tx.Exec(`
			-- Create new pins table
			CREATE TABLE pins_new (
				path TEXT PRIMARY KEY,
				created_at TEXT NOT NULL
			);

			-- Copy data from old schema
			INSERT INTO pins_new (path, created_at)
			SELECT file_path, created_at FROM pins;

			-- Drop old table
			DROP TABLE pins;

			-- Rename new table
			ALTER TABLE pins_new RENAME TO pins;

			-- Create index
			CREATE INDEX idx_pins_created_at ON pins(created_at DESC);
		`)
		if err != nil {
			return err
		}
	}

	// Ensure all tables that Go expects exist
	// (files, digests, settings, pins, sqlar should all exist from Node.js)
	// Check for sqlar just in case
	var sqlarExists bool
	err = tx.QueryRow(`
		SELECT COUNT(*) > 0
		FROM sqlite_master
		WHERE type='table' AND name='sqlar'
	`).Scan(&sqlarExists)
	if err != nil {
		return err
	}

	if !sqlarExists {
		log.Info().Msg("creating missing sqlar table")
		_, err = tx.Exec(`
			CREATE TABLE sqlar (
				name TEXT PRIMARY KEY,
				mode INT,
				mtime INT,
				sz INT,
				data BLOB
			)
		`)
		if err != nil {
			return err
		}
	}

	log.Info().Msg("database upgrade complete")
	return tx.Commit()
}
