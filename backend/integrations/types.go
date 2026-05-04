// Package integrations implements the credential layer for non-OAuth
// ingestion surfaces (HTTP webhook, WebDAV, S3-compatible).
//
// Trust model:
//
//   - Credentials are minted by the instance owner from Settings → Integrations.
//     Each credential is bound to a single protocol and a single Connect-style
//     scope (e.g. files.write:/health/apple/raw).
//   - The raw secret is shown to the owner exactly once at creation; only its
//     bcrypt hash and a short prefix are stored.
//   - Lookups happen on every request (lookup row by public_id, bcrypt-compare
//     secret); the resolved scope is then injected into the gin context where
//     the same RequireConnectScope middleware that gates OAuth Connect tokens
//     enforces it.
//
// This package owns persistence, secret generation, and verification — but
// not the per-protocol auth handlers; those live alongside the surface
// (api/integrations_webhook.go, integrations_webdav.go, integrations_s3.go).
package integrations

import "time"

// Protocol identifies which surface a credential authenticates against.
// A webhook bearer token cannot be used for SigV4 auth and vice-versa —
// the protocol field on the row narrows the credential to one surface.
type Protocol string

const (
	ProtoWebhook Protocol = "webhook"
	ProtoWebDAV  Protocol = "webdav"
	ProtoS3      Protocol = "s3"
)

// Credential is one row of integration_credentials.
//
// Secret is never persisted — only SecretHash (bcrypt) and SecretPrefix
// (first ~8 chars, kept verbatim for UI disambiguation). The raw Secret
// field is populated only on the IssuedCredential returned by Create.
type Credential struct {
	ID           string    // prefixed (e.g. "whk_a1b2c3..."). Surface-agnostic primary key.
	Name         string    // human label set by the owner ("Apple Health Shortcut")
	Protocol     Protocol
	PublicID     string    // surface-specific public identifier. Empty for webhook (only the bearer is on the wire).
	SecretPrefix string    // first ~8 chars of the raw secret, for UI ("whk_a1b2…")
	Scope        string    // single Connect scope string (e.g. "files.write:/health/apple/raw")
	CreatedAt    time.Time
	LastUsedAt   *time.Time
	LastUsedIP   string
	RevokedAt    *time.Time
}

// IssuedCredential is what we hand back to the owner on Create. The raw
// Secret (and, for WebDAV/S3, the PublicID needed to authenticate) is
// shown exactly once — never persisted, never recoverable.
type IssuedCredential struct {
	Credential
	Secret string // raw secret string. Display once, never again.
}

// IsRevoked reports whether RevokedAt has been set.
func (c Credential) IsRevoked() bool { return c.RevokedAt != nil }
