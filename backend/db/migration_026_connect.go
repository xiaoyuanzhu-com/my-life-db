package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     26,
		Description: "Add MyLifeDB Connect tables (third-party app OAuth)",
		Up: func(db *sql.DB) error {
			stmts := []string{
				// connect_clients: third-party apps that have ever asked for authorization.
				// Rows are auto-upserted on first /connect/authorize call from a client_id —
				// no separate registration step (per design: consent is the trust gate).
				// `verified` is reserved for a future allowlist/registration layer.
				`CREATE TABLE IF NOT EXISTS connect_clients (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					icon_url TEXT,
					redirect_uris TEXT NOT NULL,
					verified INTEGER NOT NULL DEFAULT 0,
					first_seen_at INTEGER NOT NULL,
					last_seen_at INTEGER NOT NULL
				)`,

				// connect_grants: durable record "owner trusts client X with scopes Y".
				// One row per client_id. Re-consent is silent if requested scopes are a
				// subset of granted_scopes; the row is unioned-in on grant; deleted on revoke.
				`CREATE TABLE IF NOT EXISTS connect_grants (
					client_id TEXT PRIMARY KEY,
					scopes TEXT NOT NULL,
					granted_at INTEGER NOT NULL,
					last_used_at INTEGER,
					FOREIGN KEY (client_id) REFERENCES connect_clients(id) ON DELETE CASCADE
				)`,

				// connect_authz_codes: short-lived one-time codes from the authorize step.
				// Hashed (sha256) so the DB never stores the raw value. Single-use:
				// row is DELETEd on token exchange.
				`CREATE TABLE IF NOT EXISTS connect_authz_codes (
					code_hash TEXT PRIMARY KEY,
					client_id TEXT NOT NULL,
					redirect_uri TEXT NOT NULL,
					scopes TEXT NOT NULL,
					code_challenge TEXT NOT NULL,
					code_challenge_method TEXT NOT NULL,
					expires_at INTEGER NOT NULL,
					created_at INTEGER NOT NULL,
					FOREIGN KEY (client_id) REFERENCES connect_clients(id) ON DELETE CASCADE
				)`,

				// connect_tokens: access + refresh tokens. Hashed at rest.
				// kind ∈ {'access','refresh'}. parent_hash links a refresh-rotation chain
				// (revoking a parent revokes the chain — RFC 6749 §10.4 / OAuth 2.1).
				// revoked_at is the soft-delete column; expired/revoked rows are pruned
				// lazily on lookup and via housekeeping.
				`CREATE TABLE IF NOT EXISTS connect_tokens (
					token_hash TEXT PRIMARY KEY,
					kind TEXT NOT NULL,
					client_id TEXT NOT NULL,
					scopes TEXT NOT NULL,
					parent_hash TEXT,
					expires_at INTEGER NOT NULL,
					created_at INTEGER NOT NULL,
					last_used_at INTEGER,
					revoked_at INTEGER,
					FOREIGN KEY (client_id) REFERENCES connect_clients(id) ON DELETE CASCADE
				)`,

				// connect_audit: every Connect-authenticated API call, for the
				// "view activity" panel in Settings → Connected Apps. Caps at the
				// most recent N rows per client via background pruning (TODO).
				`CREATE TABLE IF NOT EXISTS connect_audit (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					client_id TEXT NOT NULL,
					ts INTEGER NOT NULL,
					method TEXT NOT NULL,
					path TEXT NOT NULL,
					status INTEGER NOT NULL,
					scope TEXT,
					FOREIGN KEY (client_id) REFERENCES connect_clients(id) ON DELETE CASCADE
				)`,

				`CREATE INDEX IF NOT EXISTS idx_connect_tokens_client    ON connect_tokens(client_id)`,
				`CREATE INDEX IF NOT EXISTS idx_connect_tokens_parent    ON connect_tokens(parent_hash)`,
				`CREATE INDEX IF NOT EXISTS idx_connect_tokens_expires   ON connect_tokens(expires_at)`,
				`CREATE INDEX IF NOT EXISTS idx_connect_codes_expires    ON connect_authz_codes(expires_at)`,
				`CREATE INDEX IF NOT EXISTS idx_connect_audit_client_ts  ON connect_audit(client_id, ts DESC)`,
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
