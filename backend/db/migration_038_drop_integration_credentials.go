package db

import (
	"database/sql"
	"fmt"
)

func init() {
	RegisterMigration(Migration{
		Version:     38,
		Description: "Drop integration_credentials and integration_audit tables (legacy webhook/WebDAV/S3 surfaces removed)",
		Up:          migration038Up,
		Target:      DBRoleApp,
	})
}

// migration038Up drops the two tables that backed the legacy non-OAuth
// integration surfaces (HTTP webhook, credential-gated WebDAV, S3-compatible).
// Those surfaces were removed entirely; the remaining WebDAV ingest at
// /webdav now uses the standard backend auth middleware and needs no
// per-credential storage.
//
// Statements are idempotent (DROP ... IF EXISTS) so this is safe to run
// on either an existing app.sqlite (does the work) or a fresh one (no-op).
func migration038Up(db *sql.DB) error {
	stmts := []string{
		// Drop the supporting index first for tidiness; SQLite would
		// drop it automatically when the table is dropped, but
		// explicit matches how migration_031 declares it.
		`DROP INDEX IF EXISTS idx_integration_credentials_proto_pubid`,
		`DROP TABLE IF EXISTS integration_credentials`,

		`DROP INDEX IF EXISTS idx_integration_audit_credential_ts`,
		`DROP TABLE IF EXISTS integration_audit`,
	}

	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			snippet := s
			if len(snippet) > 60 {
				snippet = snippet[:60]
			}
			return fmt.Errorf("migration038: exec %q: %w", snippet, err)
		}
	}
	return nil
}
