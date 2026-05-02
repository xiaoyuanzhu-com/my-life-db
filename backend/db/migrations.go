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

	// Compute the highest version this binary knows about across ALL roles.
	// The downgrade check compares against this rather than the per-role max
	// because schema_version may legitimately contain entries for other roles:
	//   - Existing users migrating from the pre-split single-DB layout inherit
	//     a schema_version with both app-tagged and index-tagged versions in
	//     what becomes app.sqlite.
	//   - Migrations whose effects were consolidated into a later one (e.g.,
	//     11, 14, 27 → 028) are deleted from the registry but their version
	//     numbers remain in legacy schema_version tables.
	// Either case is harmless: those versions just don't get re-applied.
	// The check still catches a true downgrade (a newer binary applied a
	// version this binary doesn't know about, in any role).
	var maxOverall int
	for _, m := range migrations {
		if m.Version > maxOverall {
			maxOverall = m.Version
		}
	}

	if maxOverall > 0 && currentVersion > maxOverall {
		return fmt.Errorf(
			"schema version conflict: %s db is at version %d but the highest registered migration is %d; "+
				"this binary is likely older than the database. Refusing to start to avoid "+
				"corrupting migration history",
			role.String(), currentVersion, maxOverall,
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
