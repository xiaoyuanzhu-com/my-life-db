package integrations

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/connect"
)

// Store is the persistence layer for integration credentials. Backed by
// the project's SQLite app DB. The schema is owned by
// db/migration_031_integration_credentials.go; this constructor does not
// run DDL.
type Store struct {
	db *sql.DB
}

// NewStore builds a Store over the given SQLite handle.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Create mints a fresh credential row, returning the issued value (raw secret
// included). The caller must show the raw secret to the owner immediately and
// never re-fetch it; only the bcrypt hash is persisted.
//
// scope is parsed via connect.ParseScopes — the credential holds exactly one
// scope so we reject empty input or anything containing more than one scope
// token. Reusing the Connect parser means typos and unknown families surface
// at create time, not request time.
func (s *Store) Create(name string, p Protocol, scope string) (*IssuedCredential, error) {
	if name == "" {
		return nil, errors.New("name is required")
	}
	if scope == "" {
		return nil, errors.New("scope is required")
	}
	parsed, err := connect.ParseScopes(scope)
	if err != nil {
		return nil, fmt.Errorf("invalid scope: %w", err)
	}
	if len(parsed) != 1 {
		return nil, errors.New("credential must have exactly one scope")
	}

	id, err := NewID(p)
	if err != nil {
		return nil, err
	}
	publicID, err := NewPublicID(p)
	if err != nil {
		return nil, err
	}
	raw, hash, prefix, err := NewSecret(p)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	_, err = s.db.Exec(
		`INSERT INTO integration_credentials
		 (id, name, protocol, public_id, secret_hash, secret_prefix, scope, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, name, string(p), nullIfEmpty(publicID), hash, prefix, parsed.String(), now.Unix(),
	)
	if err != nil {
		return nil, err
	}

	return &IssuedCredential{
		Credential: Credential{
			ID:           id,
			Name:         name,
			Protocol:     p,
			PublicID:     publicID,
			SecretPrefix: prefix,
			Scope:        parsed.String(),
			CreatedAt:    now,
		},
		Secret: raw,
	}, nil
}

// List returns all non-revoked credentials, newest first. Used by the
// Settings UI.
func (s *Store) List() ([]Credential, error) {
	rows, err := s.db.Query(
		`SELECT id, name, protocol, public_id, secret_prefix, scope,
		        created_at, last_used_at, last_used_ip, revoked_at
		 FROM integration_credentials
		 WHERE revoked_at IS NULL
		 ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Credential
	for rows.Next() {
		c, err := scanCredential(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Get returns a credential by id, or (nil, nil) if not found.
func (s *Store) Get(id string) (*Credential, error) {
	row := s.db.QueryRow(
		`SELECT id, name, protocol, public_id, secret_prefix, scope,
		        created_at, last_used_at, last_used_ip, revoked_at
		 FROM integration_credentials WHERE id = ?`, id,
	)
	c, err := scanCredentialRow(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return c, err
}

// LookupActiveByID returns a non-revoked credential by id (used by the
// webhook surface: the bearer token's ID prefix tells us which row to load,
// then VerifySecret confirms the hash).
//
// Returns (nil, nil) for unknown / revoked.
func (s *Store) LookupActiveByID(id string) (*Credential, error) {
	c, err := s.Get(id)
	if err != nil || c == nil {
		return c, err
	}
	if c.IsRevoked() {
		return nil, nil
	}
	return c, nil
}

// LookupActiveByPublicID returns a non-revoked credential by (protocol, public_id).
// Used by WebDAV (basic-auth username) and S3 (SigV4 access key id).
//
// Returns (nil, nil) for unknown / revoked.
func (s *Store) LookupActiveByPublicID(p Protocol, publicID string) (*Credential, error) {
	if publicID == "" {
		return nil, nil
	}
	row := s.db.QueryRow(
		`SELECT id, name, protocol, public_id, secret_prefix, scope,
		        created_at, last_used_at, last_used_ip, revoked_at
		 FROM integration_credentials
		 WHERE protocol = ? AND public_id = ? AND revoked_at IS NULL`,
		string(p), publicID,
	)
	c, err := scanCredentialRow(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return c, err
}

// VerifyHash returns the bcrypt hash for `id` so the per-protocol verifier
// can call VerifySecret without leaking it through a Credential return.
func (s *Store) VerifyHash(id string) (string, error) {
	var h string
	err := s.db.QueryRow(
		`SELECT secret_hash FROM integration_credentials WHERE id = ? AND revoked_at IS NULL`, id,
	).Scan(&h)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return h, err
}

// TouchLastUsed updates last_used_at + last_used_ip. Best-effort; non-fatal
// if it fails. Called from the per-protocol auth middleware after a
// successful verification.
func (s *Store) TouchLastUsed(id, ip string) {
	_, _ = s.db.Exec(
		`UPDATE integration_credentials SET last_used_at = ?, last_used_ip = ? WHERE id = ?`,
		time.Now().Unix(), nullIfEmpty(ip), id,
	)
}

// RecordAudit appends a row to integration_audit for one gated request.
// Best-effort; failure logs nowhere and does not propagate — the goroutine
// that calls this from RequestPrincipal.AuditFn already runs detached.
//
// `scopeFamily` is the family that satisfied the request on success (e.g.
// "files.write") or "" on denial — same convention as connect_audit's scope
// column.
func (s *Store) RecordAudit(credentialID, ip, method, path string, status int, scopeFamily string) {
	_, _ = s.db.Exec(
		`INSERT INTO integration_audit (credential_id, timestamp, ip, method, path, status, scope_family)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		credentialID, time.Now().Unix(), nullIfEmpty(ip), method, path, status, scopeFamily,
	)
}

// Revoke soft-deletes a credential by stamping revoked_at. After this, all
// lookups for the credential return nil and incoming requests using its
// secret are rejected.
//
// Idempotent: revoking an already-revoked or unknown id returns nil.
func (s *Store) Revoke(id string) error {
	_, err := s.db.Exec(
		`UPDATE integration_credentials SET revoked_at = ?
		 WHERE id = ? AND revoked_at IS NULL`,
		time.Now().Unix(), id,
	)
	return err
}

// ---------------------------------------------------------------------------
// scan helpers
// ---------------------------------------------------------------------------

// rowScanner is implemented by both *sql.Row and *sql.Rows so we can share
// scanning code.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanCredential(r rowScanner) (Credential, error) {
	var (
		c             Credential
		protoStr      string
		publicIDNS    sql.NullString
		createdAt     int64
		lastUsedAtNS  sql.NullInt64
		lastUsedIPNS  sql.NullString
		revokedAtNS   sql.NullInt64
	)
	if err := r.Scan(&c.ID, &c.Name, &protoStr, &publicIDNS, &c.SecretPrefix, &c.Scope,
		&createdAt, &lastUsedAtNS, &lastUsedIPNS, &revokedAtNS); err != nil {
		return Credential{}, err
	}
	c.Protocol = Protocol(protoStr)
	c.PublicID = publicIDNS.String
	c.CreatedAt = time.Unix(createdAt, 0)
	if lastUsedAtNS.Valid {
		t := time.Unix(lastUsedAtNS.Int64, 0)
		c.LastUsedAt = &t
	}
	c.LastUsedIP = lastUsedIPNS.String
	if revokedAtNS.Valid {
		t := time.Unix(revokedAtNS.Int64, 0)
		c.RevokedAt = &t
	}
	return c, nil
}

func scanCredentialRow(r *sql.Row) (*Credential, error) {
	c, err := scanCredential(r)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
