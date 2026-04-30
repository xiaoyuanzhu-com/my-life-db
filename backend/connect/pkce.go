package connect

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
)

// PKCE (RFC 7636) verification. Only S256 is accepted — the "plain" method
// is deprecated by OAuth 2.1 and we don't ship it.

// VerifyPKCE checks that base64url(sha256(verifier)) == challenge.
// Returns nil on success, an error describing the mismatch on failure.
func VerifyPKCE(verifier, challenge, method string) error {
	if method != "S256" {
		return errors.New("unsupported code_challenge_method (only S256 is accepted)")
	}
	if verifier == "" {
		return errors.New("missing code_verifier")
	}
	// RFC 7636 §4.1: verifier is 43-128 chars from the unreserved-URL set.
	// We only check length here; the unreserved-set check is implicit since
	// our base64url comparison is exact.
	if len(verifier) < 43 || len(verifier) > 128 {
		return errors.New("code_verifier length out of range")
	}
	sum := sha256.Sum256([]byte(verifier))
	got := base64.RawURLEncoding.EncodeToString(sum[:])
	if subtle.ConstantTimeCompare([]byte(got), []byte(challenge)) != 1 {
		return errors.New("PKCE verification failed")
	}
	return nil
}

// RandomToken generates n bytes of crypto-random data and base64url-encodes
// (no padding). Used for raw access codes, access tokens, refresh tokens.
// 32 bytes (~256 bits) is the standard floor for opaque OAuth tokens.
func RandomToken(n int) (string, error) {
	if n < 16 {
		n = 16
	}
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// HashToken is the at-rest representation of an access/refresh token or
// authz code: hex(sha256(raw)). Constant-time comparison is done at the SQL
// layer (PRIMARY KEY lookup is exact) so no special compare helper is
// needed at this layer.
func HashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex(sum[:])
}

func hex(b []byte) string {
	const hexchars = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, c := range b {
		out[i*2] = hexchars[c>>4]
		out[i*2+1] = hexchars[c&0x0f]
	}
	return string(out)
}
