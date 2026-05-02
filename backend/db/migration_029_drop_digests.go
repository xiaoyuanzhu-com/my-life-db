package db

import (
	"database/sql"
	"fmt"
)

func init() {
	RegisterMigration(Migration{
		Version:     29,
		Description: "Drop digests table and its indexes (digest system removed)",
		Up:          migration029Up,
		Target:      DBRoleIndex,
	})
}

// migration029Up drops the digests table along with its three supporting
// indexes (file_path, digester, status). The digest worker, the api/digest
// handlers, and all readers were removed in the same change set, so no
// callers reference these tables anymore.
//
// Statements are idempotent (DROP ... IF EXISTS) so this is safe to run on
// either a populated index.sqlite (does the work) or a fresh one (no-op).
func migration029Up(db *sql.DB) error {
	stmts := []string{
		// Drop indexes first to keep the order tidy. SQLite would drop
		// them automatically when the table is dropped, but explicit is
		// nicer for readability and matches how migration_028 declares
		// them.
		`DROP INDEX IF EXISTS idx_digests_file_path`,
		`DROP INDEX IF EXISTS idx_digests_digester`,
		`DROP INDEX IF EXISTS idx_digests_status`,
		`DROP TABLE IF EXISTS digests`,
	}

	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			snippet := s
			if len(snippet) > 60 {
				snippet = snippet[:60]
			}
			return fmt.Errorf("migration029: exec %q: %w", snippet, err)
		}
	}
	return nil
}
