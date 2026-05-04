package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     32,
		Description: "Add integration_audit table (per-call audit log for webhook/WebDAV/S3 surfaces)",
		Target:      DBRoleApp,
		Up: func(db *sql.DB) error {
			stmts := []string{
				// integration_audit: one row per gated request that hit a non-OAuth
				// ingestion surface (webhook in Phase 1; WebDAV + S3 land in later
				// phases). Mirrors the shape of connect_audit so the future
				// "Audit" panel in Settings → Integrations can render the same
				// way as Settings → Connected Apps.
				//
				// `credential_id` is not a foreign key — when the owner revokes a
				// credential the audit history must outlive the row. (connect_audit
				// uses ON DELETE CASCADE, but credentials here are never hard-deleted
				// from the table, only soft-revoked; the audit rows survive both
				// kinds of cleanup.)
				//
				// `scope_family` records the family that satisfied the request
				// (e.g. "files.write") on success, empty on denial — useful when
				// triaging "why did this credential 403".
				`CREATE TABLE IF NOT EXISTS integration_audit (
					id            INTEGER PRIMARY KEY AUTOINCREMENT,
					credential_id TEXT NOT NULL,
					timestamp     INTEGER NOT NULL,
					ip            TEXT,
					method        TEXT NOT NULL,
					path          TEXT NOT NULL,
					status        INTEGER NOT NULL,
					scope_family  TEXT NOT NULL
				)`,

				`CREATE INDEX IF NOT EXISTS idx_integration_audit_credential_ts
					ON integration_audit(credential_id, timestamp DESC)`,
			}
			for _, s := range stmts {
				if _, err := db.Exec(s); err != nil {
					return err
				}
			}
			return nil
		},
	})
}
