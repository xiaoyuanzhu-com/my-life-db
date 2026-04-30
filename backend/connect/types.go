// Package connect implements MyLifeDB Connect — an OAuth 2.1 authorization
// server (with PKCE) that lets third-party apps request scoped access to a
// MyLifeDB instance.
//
// Trust model (Phase 1, "allow any"):
//
//   - No pre-registration. Apps self-declare client_id + name + icon + redirect_uri
//     at /connect/authorize. The first /connect/authorize call upserts a row
//     into connect_clients; subsequent calls reuse it. Consent is the trust gate.
//   - Single-user instance: all grants are owned by the instance owner. No notion
//     of multiple human principals.
//   - Path-scoped capabilities: scopes carry a path prefix (e.g. files.read:/journal),
//     enforced by middleware on resource endpoints.
//
// Future layers (registration / verified badge / allowlist) plug in via
// connect_clients.verified — protocol unchanged.
package connect

import "time"

// Client is a third-party app that has ever asked to authorize against this
// MyLifeDB instance. Auto-created by the authorize handler on first sight.
type Client struct {
	ID           string    // app-chosen, stable across runs (e.g. "com.acme.notes")
	Name         string    // display name shown on consent screen
	IconURL      string    // optional icon URL shown on consent screen
	RedirectURIs []string  // accepted redirect URIs (one per registration; we union over time)
	Verified     bool      // future: set by owner / allowlist; UI shows a badge
	FirstSeenAt  time.Time // first /connect/authorize call from this client_id
	LastSeenAt   time.Time // most recent /connect/authorize call
}

// Grant is the durable record "owner has consented to client X with scopes Y".
// Re-consent is silent when an authorize request asks for a subset of these
// scopes; otherwise the consent screen highlights the new scopes only.
type Grant struct {
	ClientID   string
	Scopes     ScopeSet
	GrantedAt  time.Time
	LastUsedAt *time.Time
}

// AuthzCode is a one-time code minted on consent and exchanged at /connect/token.
// Stored hashed; raw value is returned to the client exactly once.
type AuthzCode struct {
	CodeHash            string    // sha256(raw_code) hex
	ClientID            string
	RedirectURI         string
	Scopes              ScopeSet
	CodeChallenge       string    // PKCE
	CodeChallengeMethod string    // "S256" (only)
	ExpiresAt           time.Time // ~60s after creation
	CreatedAt           time.Time
}

// TokenKind enumerates the two token types we issue.
type TokenKind string

const (
	KindAccess  TokenKind = "access"
	KindRefresh TokenKind = "refresh"
)

// Token is an issued access or refresh token. Stored hashed; raw value is
// returned to the client exactly once at issuance. Refresh tokens form a
// rotation chain via parent_hash — revoking any ancestor revokes the chain.
type Token struct {
	Hash       string // sha256(raw_token) hex
	Kind       TokenKind
	ClientID   string
	Scopes     ScopeSet
	ParentHash string     // refresh-rotation parent (empty for access tokens and the original refresh)
	ExpiresAt  time.Time
	CreatedAt  time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
}

// IssuedToken is what we hand back to the client over the wire — raw bearer
// strings plus expiry. Never persisted; the hashed Token row is what survives.
type IssuedToken struct {
	AccessToken      string
	RefreshToken     string
	AccessExpiresIn  int // seconds
	RefreshExpiresIn int // seconds
	Scopes           ScopeSet
}

// AuditEntry is one row for the per-app activity log shown in Settings.
type AuditEntry struct {
	ID       int64
	ClientID string
	Ts       time.Time
	Method   string
	Path     string
	Status   int
	Scope    string // the scope that satisfied this request, if any
}

// Lifetimes for issued tokens. Kept liberal but not infinite — refresh
// rotation is the long-lived primitive; access tokens are short.
const (
	AuthzCodeTTL    = 60 * time.Second
	AccessTokenTTL  = 1 * time.Hour
	RefreshTokenTTL = 30 * 24 * time.Hour
)
