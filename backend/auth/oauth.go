package auth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// AuthMode represents the authentication mode
type AuthMode string

const (
	AuthModeNone     AuthMode = "none"
	AuthModePassword AuthMode = "password"
	AuthModeOAuth    AuthMode = "oauth"
)

// OAuthConfig holds OAuth configuration
type OAuthConfig struct {
	ClientID         string
	ClientSecret     string
	IssuerURL        string
	RedirectURI      string
	JWKSURL          string
	ExpectedUsername string
}

// JWTPayload represents the decoded JWT payload
type JWTPayload struct {
	Sub               string `json:"sub"`
	Email             string `json:"email,omitempty"`
	PreferredUsername string `json:"preferred_username,omitempty"`
	Exp               int64  `json:"exp,omitempty"`
	Iat               int64  `json:"iat,omitempty"`
	Iss               string `json:"iss,omitempty"`
	Aud               any    `json:"aud,omitempty"` // Can be string or []string
}

// JWKS represents JSON Web Key Set
type JWKS struct {
	Keys []JWK `json:"keys"`
}

// JWK represents a single JSON Web Key
type JWK struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
	Alg string `json:"alg,omitempty"`
}

var (
	jwksCache     *JWKS
	jwksCacheLock sync.RWMutex
	jwksCacheTime time.Time
	jwksCacheTTL  = 1 * time.Hour
)

// GetAuthMode returns the current authentication mode
func GetAuthMode() AuthMode {
	cfg := config.Get()
	mode := strings.ToLower(cfg.AuthMode)

	switch mode {
	case "password":
		return AuthModePassword
	case "oauth":
		return AuthModeOAuth
	default:
		return AuthModeNone
	}
}

// IsOAuthEnabled checks if OAuth is enabled
func IsOAuthEnabled() bool {
	return GetAuthMode() == AuthModeOAuth
}

// IsPasswordAuthEnabled checks if password auth is enabled
func IsPasswordAuthEnabled() bool {
	return GetAuthMode() == AuthModePassword
}

// IsAuthRequired checks if any auth is required
func IsAuthRequired() bool {
	return GetAuthMode() != AuthModeNone
}

// GetOAuthConfig returns OAuth configuration from environment
func GetOAuthConfig() (*OAuthConfig, error) {
	cfg := config.Get()

	if cfg.OAuthClientID == "" || cfg.OAuthClientSecret == "" ||
		cfg.OAuthIssuerURL == "" || cfg.OAuthRedirectURI == "" ||
		cfg.OAuthJWKSURL == "" {
		return nil, fmt.Errorf("OAuth configuration incomplete")
	}

	return &OAuthConfig{
		ClientID:         cfg.OAuthClientID,
		ClientSecret:     cfg.OAuthClientSecret,
		IssuerURL:        cfg.OAuthIssuerURL,
		RedirectURI:      cfg.OAuthRedirectURI,
		JWKSURL:          cfg.OAuthJWKSURL,
		ExpectedUsername: cfg.OAuthExpectedUsername,
	}, nil
}

// FetchJWKS fetches and caches the JWKS from the OAuth provider
func FetchJWKS() (*JWKS, error) {
	jwksCacheLock.RLock()
	if jwksCache != nil && time.Since(jwksCacheTime) < jwksCacheTTL {
		defer jwksCacheLock.RUnlock()
		return jwksCache, nil
	}
	jwksCacheLock.RUnlock()

	// Fetch new JWKS
	cfg, err := GetOAuthConfig()
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", cfg.JWKSURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create JWKS request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch JWKS: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("JWKS endpoint returned status %d", resp.StatusCode)
	}

	var jwks JWKS
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return nil, fmt.Errorf("failed to decode JWKS: %w", err)
	}

	// Update cache
	jwksCacheLock.Lock()
	jwksCache = &jwks
	jwksCacheTime = time.Now()
	jwksCacheLock.Unlock()

	log.Info().Str("url", cfg.JWKSURL).Int("keys", len(jwks.Keys)).Msg("JWKS fetched")

	return &jwks, nil
}

// jwkToRSAPublicKey converts a JWK to an RSA public key
func jwkToRSAPublicKey(jwk *JWK) (*rsa.PublicKey, error) {
	if jwk.Kty != "RSA" {
		return nil, fmt.Errorf("unsupported key type: %s", jwk.Kty)
	}

	// Decode the modulus (n) - base64url encoded
	nBytes, err := base64.RawURLEncoding.DecodeString(jwk.N)
	if err != nil {
		return nil, fmt.Errorf("failed to decode modulus: %w", err)
	}

	// Decode the exponent (e) - base64url encoded
	eBytes, err := base64.RawURLEncoding.DecodeString(jwk.E)
	if err != nil {
		return nil, fmt.Errorf("failed to decode exponent: %w", err)
	}

	// Convert bytes to big integers
	n := new(big.Int).SetBytes(nBytes)

	// Convert exponent bytes to int
	var e int
	for _, b := range eBytes {
		e = e<<8 + int(b)
	}

	return &rsa.PublicKey{
		N: n,
		E: e,
	}, nil
}

// ValidateJWT validates a JWT token and returns the payload
func ValidateJWT(tokenString string) (*JWTPayload, error) {
	cfg, err := GetOAuthConfig()
	if err != nil {
		return nil, err
	}

	// Parse the token without validation first to get the key ID
	parser := jwt.NewParser(jwt.WithoutClaimsValidation())
	token, _, err := parser.ParseUnverified(tokenString, jwt.MapClaims{})
	if err != nil {
		return nil, fmt.Errorf("failed to parse token: %w", err)
	}

	// Get the key ID from the token header
	kid, ok := token.Header["kid"].(string)
	if !ok {
		return nil, fmt.Errorf("token missing kid header")
	}

	// Fetch JWKS and find the matching key
	jwks, err := FetchJWKS()
	if err != nil {
		return nil, err
	}

	var matchingKey *JWK
	for _, key := range jwks.Keys {
		if key.Kid == kid {
			matchingKey = &key
			break
		}
	}

	if matchingKey == nil {
		return nil, fmt.Errorf("no matching key found for kid: %s", kid)
	}

	// Convert JWK to RSA public key
	rsaKey, err := jwkToRSAPublicKey(matchingKey)
	if err != nil {
		return nil, fmt.Errorf("failed to convert JWK to RSA key: %w", err)
	}

	// Parse and validate the token with proper RSA signature verification
	claims := jwt.MapClaims{}
	token, err = jwt.ParseWithClaims(tokenString, claims, func(t *jwt.Token) (interface{}, error) {
		// Verify signing method is RSA
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return rsaKey, nil
	})

	if err != nil {
		return nil, fmt.Errorf("token validation failed: %w", err)
	}

	if !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}

	// Extract payload from claims
	payload := &JWTPayload{}
	if sub, ok := claims["sub"].(string); ok {
		payload.Sub = sub
	}
	if email, ok := claims["email"].(string); ok {
		payload.Email = email
	}
	if username, ok := claims["preferred_username"].(string); ok {
		payload.PreferredUsername = username
	}
	if exp, ok := claims["exp"].(float64); ok {
		payload.Exp = int64(exp)
	}
	if iss, ok := claims["iss"].(string); ok {
		payload.Iss = iss
	}

	// Validate issuer
	if payload.Iss != cfg.IssuerURL {
		return nil, fmt.Errorf("invalid issuer: expected %s, got %s", cfg.IssuerURL, payload.Iss)
	}

	return payload, nil
}

// GetUsernameFromPayload extracts the username from a JWT payload
func GetUsernameFromPayload(payload *JWTPayload) string {
	if payload.PreferredUsername != "" {
		return payload.PreferredUsername
	}
	if payload.Email != "" {
		parts := strings.Split(payload.Email, "@")
		return parts[0]
	}
	return payload.Sub
}

// VerifyExpectedUsername verifies the username matches the expected username
func VerifyExpectedUsername(username string) bool {
	cfg, err := GetOAuthConfig()
	if err != nil {
		return false
	}

	if cfg.ExpectedUsername == "" {
		return true // No expected username configured, accept any
	}

	return username == cfg.ExpectedUsername
}
