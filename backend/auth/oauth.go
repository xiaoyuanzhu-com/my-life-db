package auth

import (
	"strings"

	"github.com/xiaoyuanzhu-com/my-life-db/config"
)

// AuthMode represents the authentication mode
type AuthMode string

const (
	AuthModeNone     AuthMode = "none"
	AuthModePassword AuthMode = "password"
	AuthModeOAuth    AuthMode = "oauth"
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

// VerifyExpectedUsername verifies the username matches the expected username
func VerifyExpectedUsername(username string) bool {
	cfg := config.Get()

	if cfg.OAuthExpectedUsername == "" {
		return true // No expected username configured, accept any
	}

	return username == cfg.OAuthExpectedUsername
}
