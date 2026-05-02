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
	Target      DBRole // DBRoleIndex or DBRoleApp — used by Task 9 to filter; ignored here
}

// migrations is the list of all migrations to apply
// This will be populated by migration files
var migrations []Migration

// RegisterMigration adds a migration to the list
func RegisterMigration(m Migration) {
	migrations = append(migrations, m)
}

// runMigrations executes pending migrations whose Target matches role.
// Each physical SQLite file (index.sqlite, app.sqlite) maintains its own
// schema_version table, so migrations targeted at the other role are skipped
// completely — they never get an entry in this DB's schema_version.
func runMigrations(db *sql.DB, role DBRole) error {
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

	// Compute the highest version registered for this role. We use this for
	// the downgrade check — having a newer version of an OTHER role's
	// migration in this DB's schema_version is harmless (e.g., legacy
	// installs migrating from the single-DB layout), so only compare against
	// migrations that actually run on this DB.
	var maxRegistered int
	for _, m := range migrations {
		if m.Target == role && m.Version > maxRegistered {
			maxRegistered = m.Version
		}
	}

	// Refuse to run if the DB has a higher version than any registered migration
	// for this role. This usually means the binary is older than the database
	// (downgrade) or a role-matching migration file was removed. Silently
	// resetting the version table would re-run migrations against an
	// already-migrated schema and cause subtle runtime failures, so fail
	// loudly instead. Skip the check entirely when this role has no
	// registered migrations at all (maxRegistered == 0) — that would
	// otherwise reject any non-empty schema_version.
	if maxRegistered > 0 && currentVersion > maxRegistered {
		return fmt.Errorf(
			"schema version conflict: %s db is at version %d but the highest registered migration for this role is %d; "+
				"this binary is likely older than the database, or a migration was removed. "+
				"Refusing to start to avoid corrupting migration history",
			role.String(), currentVersion, maxRegistered,
		)
	}

	// Apply pending migrations whose Target matches this DB's role.
	for _, m := range migrations {
		if m.Target != role {
			continue
		}
		if m.Version <= currentVersion {
			continue
		}

		log.Info().
			Int("version", m.Version).
			Str("role", role.String()).
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
			Str("role", role.String()).
			Msg("migration applied successfully")
	}

	return nil
}
