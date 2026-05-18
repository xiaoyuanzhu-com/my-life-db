// Package auth exposes the configured auth mode for the backend.
//
// Two modes are supported:
//
//	none      — all APIs are open
//	password  — owner session cookie required (set by POST /api/system/auth/login)
//
// Third-party access (OAuth, Connect, scoped tokens) is the cloud gateway's
// responsibility; the backend itself is user-agnostic.
package auth

import (
	"strings"

	"github.com/xiaoyuanzhu-com/my-life-db/config"
)

// AuthMode represents the authentication mode.
type AuthMode string

const (
	AuthModeNone     AuthMode = "none"
	AuthModePassword AuthMode = "password"
)

// GetAuthMode returns the current authentication mode. Unknown values
// default to "none" — startup validation in config.load() catches the
// removed "oauth" mode before we get here.
func GetAuthMode() AuthMode {
	cfg := config.Get()
	switch strings.ToLower(cfg.AuthMode) {
	case "password":
		return AuthModePassword
	default:
		return AuthModeNone
	}
}

// IsPasswordAuthEnabled reports whether password auth is the active mode.
func IsPasswordAuthEnabled() bool {
	return GetAuthMode() == AuthModePassword
}

// IsAuthRequired reports whether any auth gate is enabled.
func IsAuthRequired() bool {
	return GetAuthMode() != AuthModeNone
}
