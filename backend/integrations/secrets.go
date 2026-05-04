package integrations

import (
	"crypto/rand"
	"encoding/base64"
	"errors"

	"golang.org/x/crypto/bcrypt"
)

// Per-protocol prefixes for credential IDs and (where applicable) public ids.
// Stripe-style prefixes make it instantly obvious in logs / settings which
// surface a leaked secret belongs to.
const (
	IDPrefixWebhook = "whk_"
	IDPrefixWebDAV  = "wdv_"
	IDPrefixS3      = "s3k_"

	// Public-id prefix for the WebDAV username and the S3 access key id.
	// Webhook has no public id (the bearer is the only thing on the wire).
	PubPrefixWebDAV = "mldav_"
	PubPrefixS3     = "AKIA_MLD_"

	// Secret prefix written into every issued raw secret so it's easy to
	// recognize in logs / .env files.
	SecretPrefixWebhook = "whks_"
	SecretPrefixWebDAV  = "wdvs_"
	SecretPrefixS3      = "s3sk_"

	// Bcrypt cost. 12 is the industry default for hash-on-every-request
	// surfaces in 2026 — ~250ms on commodity hardware. We're hashing on
	// each webhook/WebDAV/S3 call so don't push it higher without
	// adding an in-process verification cache.
	bcryptCost = 12

	// Length of the random portion of a secret (bytes pre-base64).
	// 32 bytes → ~43 chars base64url, comfortably above the OAuth opaque-token
	// floor and matches connect.RandomToken sizing.
	secretRandomBytes = 32

	// Length of the random portion of a credential id / public id (bytes pre-base64).
	idRandomBytes = 12
)

// NewID generates a new prefixed credential id for the given protocol.
func NewID(p Protocol) (string, error) {
	prefix, err := idPrefixFor(p)
	if err != nil {
		return "", err
	}
	tail, err := randB64URL(idRandomBytes)
	if err != nil {
		return "", err
	}
	return prefix + tail, nil
}

// NewPublicID generates a new public identifier for the protocols that use one
// (WebDAV username, S3 access key id). Returns ("", nil) for webhook — webhook
// has no separate public id.
func NewPublicID(p Protocol) (string, error) {
	prefix, err := pubPrefixFor(p)
	if err != nil {
		return "", err
	}
	if prefix == "" {
		return "", nil
	}
	tail, err := randB64URL(idRandomBytes)
	if err != nil {
		return "", err
	}
	return prefix + tail, nil
}

// NewSecret generates a fresh prefixed secret for the given protocol. Returns
// (rawSecret, hash, prefixForDisplay) — the caller persists hash + prefix and
// hands rawSecret back to the owner exactly once.
func NewSecret(p Protocol) (raw, hash, displayPrefix string, err error) {
	prefix, err := secretPrefixFor(p)
	if err != nil {
		return "", "", "", err
	}
	tail, err := randB64URL(secretRandomBytes)
	if err != nil {
		return "", "", "", err
	}
	raw = prefix + tail
	h, err := bcrypt.GenerateFromPassword([]byte(raw), bcryptCost)
	if err != nil {
		return "", "", "", err
	}
	// First ~12 chars: the prefix + a few chars of randomness. Enough
	// to disambiguate without revealing the secret.
	disp := raw
	if len(disp) > 12 {
		disp = disp[:12]
	}
	return raw, string(h), disp, nil
}

// VerifySecret reports whether `raw` matches the stored bcrypt hash.
// Constant-time by virtue of bcrypt.CompareHashAndPassword.
func VerifySecret(hash, raw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(raw)) == nil
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

func idPrefixFor(p Protocol) (string, error) {
	switch p {
	case ProtoWebhook:
		return IDPrefixWebhook, nil
	case ProtoWebDAV:
		return IDPrefixWebDAV, nil
	case ProtoS3:
		return IDPrefixS3, nil
	}
	return "", errors.New("unknown protocol")
}

func pubPrefixFor(p Protocol) (string, error) {
	switch p {
	case ProtoWebhook:
		return "", nil
	case ProtoWebDAV:
		return PubPrefixWebDAV, nil
	case ProtoS3:
		return PubPrefixS3, nil
	}
	return "", errors.New("unknown protocol")
}

func secretPrefixFor(p Protocol) (string, error) {
	switch p {
	case ProtoWebhook:
		return SecretPrefixWebhook, nil
	case ProtoWebDAV:
		return SecretPrefixWebDAV, nil
	case ProtoS3:
		return SecretPrefixS3, nil
	}
	return "", errors.New("unknown protocol")
}

func randB64URL(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
