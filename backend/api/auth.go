package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

const (
	// sessionCookieName is the cookie name for password auth sessions
	sessionCookieName = "session"
	// sessionCookieMaxAge is 30 days in seconds
	sessionCookieMaxAge = 30 * 24 * 60 * 60
)

// Login handles POST /api/auth/login
func (h *Handlers) Login(c *gin.Context) {
	var body struct {
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	// Get stored password hash
	storedHash, err := db.GetSetting("auth_password_hash")
	if err != nil {
		log.Error().Err(err).Msg("failed to get password hash")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Authentication error"})
		return
	}

	// If no password is set, create one (first login sets the password)
	if storedHash == "" {
		hash := hashPassword(body.Password)
		if err := db.SetSetting("auth_password_hash", hash); err != nil {
			log.Error().Err(err).Msg("failed to save password hash")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to set password"})
			return
		}
		storedHash = hash
		log.Info().Msg("password auth initialized with first login")
	}

	// Verify password
	if hashPassword(body.Password) != storedHash {
		log.Warn().Msg("login attempt with invalid password")
		c.JSON(http.StatusUnauthorized, gin.H{
			"success": false,
			"error":   "Invalid password",
		})
		return
	}

	// Generate and persist session
	sessionToken := generateSessionToken()
	session, err := db.CreateSession(sessionToken)
	if err != nil {
		log.Error().Err(err).Msg("failed to create session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create session"})
		return
	}

	// Set session cookie
	cfg := config.Get()
	secure := !cfg.IsDevelopment()
	c.SetCookie(sessionCookieName, sessionToken, sessionCookieMaxAge, "/", "", secure, true)

	log.Info().Str("sessionId", session.ID[:8]+"...").Msg("login successful")

	c.JSON(http.StatusOK, gin.H{
		"success":   true,
		"sessionId": session.ID,
	})
}

// Logout handles POST /api/auth/logout
func (h *Handlers) Logout(c *gin.Context) {
	// Get session token from cookie
	sessionToken, err := c.Cookie(sessionCookieName)
	if err == nil && sessionToken != "" {
		// Delete session from database
		if err := db.DeleteSession(sessionToken); err != nil {
			log.Error().Err(err).Msg("failed to delete session")
		}
	}

	// Clear session cookie
	c.SetCookie(sessionCookieName, "", -1, "/", "", false, true)

	c.JSON(http.StatusOK, gin.H{
		"success": true,
	})
}

// ValidatePasswordSession checks if the session cookie contains a valid session
// Returns the session if valid, nil otherwise
func ValidatePasswordSession(c *gin.Context) *db.Session {
	sessionToken, err := c.Cookie(sessionCookieName)
	if err != nil || sessionToken == "" {
		return nil
	}

	session, err := db.GetSession(sessionToken)
	if err != nil {
		log.Error().Err(err).Msg("failed to get session")
		return nil
	}

	if session == nil {
		// Session not found or expired
		return nil
	}

	// Touch session to update last_used_at
	if err := db.TouchSession(sessionToken); err != nil {
		log.Error().Err(err).Msg("failed to touch session")
	}

	return session
}

// Helper functions

func hashPassword(password string) string {
	hash := sha256.Sum256([]byte(password))
	return hex.EncodeToString(hash[:])
}

func generateSessionToken() string {
	bytes := make([]byte, 32)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}
