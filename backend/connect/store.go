package connect

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Store is the persistence layer for Connect. Backed by the project SQLite
// instance via the *sql.DB the caller already owns. No globals; constructor
// takes the connection so tests can use an in-memory DB.
type Store struct {
	db *sql.DB
}

// NewStore builds a Store over the given SQLite handle. The schema is
// owned by db/migration_026_connect.go; this constructor does not run DDL.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

// UpsertClient creates a new client row or refreshes an existing one with
// the latest name/icon/redirect_uri pair from the authorize request.
// Redirect URIs are unioned over time so a client that registers multiple
// callbacks (web + native) accumulates them across runs.
func (s *Store) UpsertClient(id, name, iconURL, redirectURI string) error {
	if id == "" || name == "" || redirectURI == "" {
		return errors.New("client id, name, and redirect_uri are required")
	}
	now := time.Now().Unix()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var (
		existingName    string
		existingIcon    sql.NullString
		redirectURIsRaw string
	)
	row := tx.QueryRow(`SELECT name, icon_url, redirect_uris FROM connect_clients WHERE id = ?`, id)
	err = row.Scan(&existingName, &existingIcon, &redirectURIsRaw)
	switch {
	case err == sql.ErrNoRows:
		uris, _ := json.Marshal([]string{redirectURI})
		_, err = tx.Exec(
			`INSERT INTO connect_clients (id, name, icon_url, redirect_uris, verified, first_seen_at, last_seen_at)
			 VALUES (?, ?, ?, ?, 0, ?, ?)`,
			id, name, nullIfEmpty(iconURL), string(uris), now, now,
		)
		if err != nil {
			return err
		}
	case err != nil:
		return err
	default:
		// Existing client — union redirect URIs, refresh metadata.
		var existingURIs []string
		_ = json.Unmarshal([]byte(redirectURIsRaw), &existingURIs)
		merged := unionStrings(existingURIs, []string{redirectURI})
		mergedRaw, _ := json.Marshal(merged)
		_, err = tx.Exec(
			`UPDATE connect_clients
			 SET name = ?, icon_url = ?, redirect_uris = ?, last_seen_at = ?
			 WHERE id = ?`,
			name, nullIfEmpty(iconURL), string(mergedRaw), now, id,
		)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetClient returns a client by id, or (nil, nil) if not found.
func (s *Store) GetClient(id string) (*Client, error) {
	row := s.db.QueryRow(
		`SELECT id, name, icon_url, redirect_uris, verified, first_seen_at, last_seen_at
		 FROM connect_clients WHERE id = ?`, id,
	)
	c, err := scanClient(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return c, err
}

// ListClients returns all known clients, joined with their grant (if any),
// ordered by most-recently-seen first. Used by the Settings UI.
func (s *Store) ListClients() ([]ClientWithGrant, error) {
	rows, err := s.db.Query(
		`SELECT c.id, c.name, c.icon_url, c.redirect_uris, c.verified, c.first_seen_at, c.last_seen_at,
		        g.scopes, g.granted_at, g.last_used_at
		 FROM connect_clients c
		 LEFT JOIN connect_grants g ON g.client_id = c.id
		 ORDER BY COALESCE(g.last_used_at, c.last_seen_at) DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ClientWithGrant
	for rows.Next() {
		var (
			c             Client
			redirectsRaw  string
			iconNS        sql.NullString
			firstSeen     int64
			lastSeen      int64
			scopesNS      sql.NullString
			grantedAtNS   sql.NullInt64
			lastUsedAtNS  sql.NullInt64
		)
		if err := rows.Scan(&c.ID, &c.Name, &iconNS, &redirectsRaw, &c.Verified,
			&firstSeen, &lastSeen, &scopesNS, &grantedAtNS, &lastUsedAtNS); err != nil {
			return nil, err
		}
		c.IconURL = iconNS.String
		_ = json.Unmarshal([]byte(redirectsRaw), &c.RedirectURIs)
		c.FirstSeenAt = time.Unix(firstSeen, 0)
		c.LastSeenAt = time.Unix(lastSeen, 0)

		entry := ClientWithGrant{Client: c}
		if scopesNS.Valid {
			scopes, _ := ParseScopes(scopesNS.String)
			grant := &Grant{
				ClientID:  c.ID,
				Scopes:    scopes,
				GrantedAt: time.Unix(grantedAtNS.Int64, 0),
			}
			if lastUsedAtNS.Valid {
				t := time.Unix(lastUsedAtNS.Int64, 0)
				grant.LastUsedAt = &t
			}
			entry.Grant = grant
		}
		out = append(out, entry)
	}
	return out, rows.Err()
}

// ClientWithGrant is the row shape returned by ListClients.
type ClientWithGrant struct {
	Client Client
	Grant  *Grant // nil if the user has never granted anything to this client yet
}

// DeleteClient removes a client and (via FK cascade) all its grants, codes,
// tokens, and audit rows. Used by the "Revoke app" button.
func (s *Store) DeleteClient(id string) error {
	_, err := s.db.Exec(`DELETE FROM connect_clients WHERE id = ?`, id)
	return err
}

func scanClient(row *sql.Row) (*Client, error) {
	var (
		c            Client
		iconNS       sql.NullString
		redirectsRaw string
		firstSeen    int64
		lastSeen     int64
	)
	if err := row.Scan(&c.ID, &c.Name, &iconNS, &redirectsRaw, &c.Verified, &firstSeen, &lastSeen); err != nil {
		return nil, err
	}
	c.IconURL = iconNS.String
	_ = json.Unmarshal([]byte(redirectsRaw), &c.RedirectURIs)
	c.FirstSeenAt = time.Unix(firstSeen, 0)
	c.LastSeenAt = time.Unix(lastSeen, 0)
	return &c, nil
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

// GetGrant returns the existing grant for a client, or (nil, nil) if none.
func (s *Store) GetGrant(clientID string) (*Grant, error) {
	row := s.db.QueryRow(
		`SELECT scopes, granted_at, last_used_at FROM connect_grants WHERE client_id = ?`, clientID,
	)
	var (
		scopesRaw    string
		grantedAt    int64
		lastUsedAtNS sql.NullInt64
	)
	if err := row.Scan(&scopesRaw, &grantedAt, &lastUsedAtNS); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	scopes, err := ParseScopes(scopesRaw)
	if err != nil {
		return nil, fmt.Errorf("malformed scopes in grant for %s: %w", clientID, err)
	}
	g := &Grant{ClientID: clientID, Scopes: scopes, GrantedAt: time.Unix(grantedAt, 0)}
	if lastUsedAtNS.Valid {
		t := time.Unix(lastUsedAtNS.Int64, 0)
		g.LastUsedAt = &t
	}
	return g, nil
}

// UpsertGrant stores (or unions into) a grant for the given client. The
// caller passes the FULL set the owner has approved at this consent step;
// this function unions with anything already on file so previously granted
// scopes are not lost.
func (s *Store) UpsertGrant(clientID string, scopes ScopeSet) error {
	now := time.Now().Unix()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var existingRaw string
	err = tx.QueryRow(`SELECT scopes FROM connect_grants WHERE client_id = ?`, clientID).Scan(&existingRaw)
	switch {
	case err == sql.ErrNoRows:
		_, err = tx.Exec(
			`INSERT INTO connect_grants (client_id, scopes, granted_at) VALUES (?, ?, ?)`,
			clientID, scopes.String(), now,
		)
		if err != nil {
			return err
		}
	case err != nil:
		return err
	default:
		existing, _ := ParseScopes(existingRaw)
		merged := Union(existing, scopes)
		_, err = tx.Exec(
			`UPDATE connect_grants SET scopes = ?, granted_at = ? WHERE client_id = ?`,
			merged.String(), now, clientID,
		)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// TouchGrant updates last_used_at on a grant when a token derived from it
// is used. Done lazily on token validation, not on every request, to avoid
// turning every authenticated read into a DB write storm.
func (s *Store) TouchGrant(clientID string) error {
	_, err := s.db.Exec(
		`UPDATE connect_grants SET last_used_at = ? WHERE client_id = ?`,
		time.Now().Unix(), clientID,
	)
	return err
}

// ---------------------------------------------------------------------------
// Authz codes
// ---------------------------------------------------------------------------

// CreateCode persists an authz code (caller passes the hashed value).
func (s *Store) CreateCode(c AuthzCode) error {
	_, err := s.db.Exec(
		`INSERT INTO connect_authz_codes
		 (code_hash, client_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		c.CodeHash, c.ClientID, c.RedirectURI, c.Scopes.String(),
		c.CodeChallenge, c.CodeChallengeMethod,
		c.ExpiresAt.Unix(), c.CreatedAt.Unix(),
	)
	return err
}

// ConsumeCode looks up + deletes an authz code in one transaction (single-use).
// Returns (nil, nil) if the code doesn't exist or has expired.
func (s *Store) ConsumeCode(codeHash string) (*AuthzCode, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var (
		c          AuthzCode
		scopesRaw  string
		expiresAt  int64
		createdAt  int64
	)
	row := tx.QueryRow(
		`SELECT code_hash, client_id, redirect_uri, scopes,
		        code_challenge, code_challenge_method, expires_at, created_at
		 FROM connect_authz_codes WHERE code_hash = ?`, codeHash,
	)
	err = row.Scan(&c.CodeHash, &c.ClientID, &c.RedirectURI, &scopesRaw,
		&c.CodeChallenge, &c.CodeChallengeMethod, &expiresAt, &createdAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.Scopes, _ = ParseScopes(scopesRaw)
	c.ExpiresAt = time.Unix(expiresAt, 0)
	c.CreatedAt = time.Unix(createdAt, 0)

	// Single-use: delete now, regardless of whether it's expired.
	if _, err := tx.Exec(`DELETE FROM connect_authz_codes WHERE code_hash = ?`, codeHash); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if time.Now().After(c.ExpiresAt) {
		return nil, nil
	}
	return &c, nil
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

// CreateToken persists an access or refresh token.
func (s *Store) CreateToken(t Token) error {
	_, err := s.db.Exec(
		`INSERT INTO connect_tokens
		 (token_hash, kind, client_id, scopes, parent_hash, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		t.Hash, string(t.Kind), t.ClientID, t.Scopes.String(),
		nullIfEmpty(t.ParentHash), t.ExpiresAt.Unix(), t.CreatedAt.Unix(),
	)
	return err
}

// LookupActiveToken returns a token by hash if it is non-revoked and unexpired.
// Returns (nil, nil) for not-found / expired / revoked.
func (s *Store) LookupActiveToken(hash string) (*Token, error) {
	row := s.db.QueryRow(
		`SELECT token_hash, kind, client_id, scopes, parent_hash, expires_at, created_at, last_used_at, revoked_at
		 FROM connect_tokens WHERE token_hash = ?`, hash,
	)
	var (
		t            Token
		kindStr      string
		scopesRaw    string
		parentNS     sql.NullString
		expiresAt    int64
		createdAt    int64
		lastUsedNS   sql.NullInt64
		revokedNS    sql.NullInt64
	)
	if err := row.Scan(&t.Hash, &kindStr, &t.ClientID, &scopesRaw, &parentNS,
		&expiresAt, &createdAt, &lastUsedNS, &revokedNS); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	if revokedNS.Valid {
		return nil, nil
	}
	if time.Now().After(time.Unix(expiresAt, 0)) {
		return nil, nil
	}
	t.Kind = TokenKind(kindStr)
	t.Scopes, _ = ParseScopes(scopesRaw)
	t.ParentHash = parentNS.String
	t.ExpiresAt = time.Unix(expiresAt, 0)
	t.CreatedAt = time.Unix(createdAt, 0)
	if lastUsedNS.Valid {
		ts := time.Unix(lastUsedNS.Int64, 0)
		t.LastUsedAt = &ts
	}
	return &t, nil
}

// TouchToken updates last_used_at. Best-effort; non-fatal if it fails.
func (s *Store) TouchToken(hash string) {
	_, _ = s.db.Exec(
		`UPDATE connect_tokens SET last_used_at = ? WHERE token_hash = ?`,
		time.Now().Unix(), hash,
	)
}

// RevokeToken marks a single token revoked. For refresh tokens, callers
// should follow up with RevokeChain so the entire rotation chain dies (RFC 6749 §10.4).
func (s *Store) RevokeToken(hash string) error {
	_, err := s.db.Exec(
		`UPDATE connect_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
		time.Now().Unix(), hash,
	)
	return err
}

// RevokeChain walks parent_hash links from the given hash, revoking every
// token in the chain in both directions (ancestors and descendants).
// Used when a refresh token is reused ("replay") — OAuth 2.1 §6.1 mandates
// killing the whole family.
func (s *Store) RevokeChain(hash string) error {
	now := time.Now().Unix()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	visited := map[string]struct{}{}
	stack := []string{hash}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if _, seen := visited[cur]; seen {
			continue
		}
		visited[cur] = struct{}{}

		// revoke
		if _, err := tx.Exec(
			`UPDATE connect_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
			now, cur,
		); err != nil {
			return err
		}

		// ancestor (parent)
		var parentNS sql.NullString
		err := tx.QueryRow(`SELECT parent_hash FROM connect_tokens WHERE token_hash = ?`, cur).Scan(&parentNS)
		if err == nil && parentNS.Valid && parentNS.String != "" {
			stack = append(stack, parentNS.String)
		}

		// descendants (children whose parent_hash = cur)
		rows, err := tx.Query(`SELECT token_hash FROM connect_tokens WHERE parent_hash = ?`, cur)
		if err != nil {
			return err
		}
		for rows.Next() {
			var child string
			if err := rows.Scan(&child); err != nil {
				rows.Close()
				return err
			}
			stack = append(stack, child)
		}
		rows.Close()
	}
	return tx.Commit()
}

// RevokeClientTokens revokes all non-revoked tokens for a client. Used when
// the user clicks "Revoke app" (in addition to DeleteClient, which cascades
// the row away). Splitting this out lets us revoke without nuking the audit
// trail in cases where we want to keep historical records.
func (s *Store) RevokeClientTokens(clientID string) error {
	_, err := s.db.Exec(
		`UPDATE connect_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL`,
		time.Now().Unix(), clientID,
	)
	return err
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

// AppendAudit records a Connect-authenticated request. Best-effort; failure
// is logged by the caller but does not block the response.
func (s *Store) AppendAudit(e AuditEntry) error {
	_, err := s.db.Exec(
		`INSERT INTO connect_audit (client_id, ts, method, path, status, scope)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		e.ClientID, e.Ts.Unix(), e.Method, e.Path, e.Status, nullIfEmpty(e.Scope),
	)
	return err
}

// ListAudit returns the most recent N audit rows for a client, newest first.
func (s *Store) ListAudit(clientID string, limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.Query(
		`SELECT id, client_id, ts, method, path, status, scope
		 FROM connect_audit WHERE client_id = ? ORDER BY ts DESC LIMIT ?`,
		clientID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []AuditEntry
	for rows.Next() {
		var (
			e       AuditEntry
			ts      int64
			scopeNS sql.NullString
		)
		if err := rows.Scan(&e.ID, &e.ClientID, &ts, &e.Method, &e.Path, &e.Status, &scopeNS); err != nil {
			return nil, err
		}
		e.Ts = time.Unix(ts, 0)
		e.Scope = scopeNS.String
		out = append(out, e)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func unionStrings(a, b []string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, s := range a {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	for _, s := range b {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}
