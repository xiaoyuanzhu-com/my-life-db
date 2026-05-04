package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     31,
		Description: "Add integration_credentials table (webhook/WebDAV/S3 protocol surfaces)",
		Target:      DBRoleApp,
		Up: func(db *sql.DB) error {
			stmts := []string{
				// integration_credentials: long-lived credentials for non-OAuth ingestion
				// surfaces (HTTP webhook, WebDAV, S3-compatible). Each row pairs one
				// public identifier with one bcrypt-hashed secret and one Connect-style
				// scope string (e.g. "files.write:health/apple/raw").
				//
				// Scope encodes the file-tree subtree the credential may write to —
				// enforced by the same RequireConnectScope middleware that gates Connect
				// tokens. WebDAV mounts the scope path as its FS root; HTTP webhook
				// validates path against the ScopeSet on each request; S3 maps the bucket
				// name to the scope's path prefix.
				//
				// `protocol` ∈ {'webhook','webdav','s3'} — narrows the credential to a
				// single surface so a webhook bearer token cannot be used for SigV4 auth.
				//
				// `public_id` — surface-specific identifier:
				//   webhook → NULL (the bearer token is the only thing on the wire)
				//   webdav  → username
				//   s3      → access key id (e.g. "AKIA...")
				// Indexed (when not revoked) so we can find the credential row by the
				// public id presented in an Authorization header.
				//
				// `secret_hash` — bcrypt hash of the secret. Never reversed; we only
				// show the raw secret once at creation, then it is gone forever.
				// `secret_prefix` — first ~8 chars of the secret, kept verbatim so the
				// settings UI can disambiguate credentials ("whk_a1b2…") without ever
				// exposing the full secret again.
				//
				// `revoked_at` is the soft-delete column. Lookups filter on
				// revoked_at IS NULL so revocation takes effect immediately without
				// losing audit history.
				`CREATE TABLE IF NOT EXISTS integration_credentials (
					id            TEXT PRIMARY KEY,
					name          TEXT NOT NULL,
					protocol      TEXT NOT NULL,
					public_id     TEXT,
					secret_hash   TEXT NOT NULL,
					secret_prefix TEXT NOT NULL,
					scope         TEXT NOT NULL,
					created_at    INTEGER NOT NULL,
					last_used_at  INTEGER,
					last_used_ip  TEXT,
					revoked_at    INTEGER
				)`,

				// Lookup index for protocols where the public id arrives on the wire
				// (WebDAV username, S3 access key). Filtered to active rows so revoked
				// credentials never collide with new ones reusing the same id.
				`CREATE INDEX IF NOT EXISTS idx_integration_credentials_proto_pubid
					ON integration_credentials(protocol, public_id)
					WHERE revoked_at IS NULL`,
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
