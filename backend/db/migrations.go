package db

import (
	"database/sql"
	"fmt"
	"sort"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Migration represents a database migration
type Migration struct {
	Version     int
	Description string
	Up          func(db *sql.DB) error
}

// migrations is the list of all migrations to apply
// This will be populated by migration files
var migrations []Migration

// RegisterMigration adds a migration to the list
func RegisterMigration(m Migration) {
	migrations = append(migrations, m)
}

// runMigrations executes all pending migrations
func runMigrations(db *sql.DB) error {
	// Ensure schema_version table exists
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER PRIMARY KEY,
			applied_at TEXT,
			description TEXT
		)
	`)
	if err != nil {
		return fmt.Errorf("failed to create schema_version table: %w", err)
	}

	// Sort migrations by version
	sort.Slice(migrations, func(i, j int) bool {
		return migrations[i].Version < migrations[j].Version
	})

	// Get current version
	var currentVersion int
	row := db.QueryRow("SELECT COALESCE(MAX(version), 0) FROM schema_version")
	if err := row.Scan(&currentVersion); err != nil {
		return fmt.Errorf("failed to get current version: %w", err)
	}

	// Detect legacy Node.js migration history: if the DB version is higher than
	// all registered Go migrations, the old version entries would cause every
	// Go migration to be skipped. Reset the version table so Go migrations run.
	if len(migrations) > 0 {
		maxRegistered := migrations[len(migrations)-1].Version
		if currentVersion > maxRegistered {
			log.Info().
				Int("db_version", currentVersion).
				Int("max_registered", maxRegistered).
				Msg("legacy migration history detected, resetting schema_version for Go migrations")
			if _, err := db.Exec("DELETE FROM schema_version"); err != nil {
				return fmt.Errorf("failed to reset legacy schema_version: %w", err)
			}
			currentVersion = 0
		}
	}

	// Apply pending migrations
	for _, m := range migrations {
		if m.Version <= currentVersion {
			continue
		}

		log.Info().
			Int("version", m.Version).
			Str("description", m.Description).
			Msg("applying migration")

		// Run migration (migrations handle their own transaction if needed)
		if err := m.Up(db); err != nil {
			return fmt.Errorf("migration %d failed: %w", m.Version, err)
		}

		// Record migration
		_, err = db.Exec(
			"INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)",
			m.Version,
			time.Now().UTC().Format(time.RFC3339),
			m.Description,
		)
		if err != nil {
			return fmt.Errorf("failed to record migration %d: %w", m.Version, err)
		}

		log.Info().
			Int("version", m.Version).
			Msg("migration applied successfully")
	}

	return nil
}

// GetCurrentVersion returns the current database schema version
func GetCurrentVersion() (int, error) {
	db := GetDB()

	var version int
	err := db.QueryRow("SELECT COALESCE(MAX(version), 0) FROM schema_version").Scan(&version)
	if err != nil {
		return 0, err
	}

	return version, nil
}
