package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var authLogger = log.GetLogger("ApiAuth")

// Login handles POST /api/auth/login
func Login(c echo.Context) error {
	var body struct {
		Password string `json:"password"`
	}
	if err := c.Bind(&body); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
	}

	// Get stored password hash
	storedHash, err := db.GetSetting("auth_password_hash")
	if err != nil {
		authLogger.Error().Err(err).Msg("failed to get password hash")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Authentication error"})
	}

	// If no password is set, create one
	if storedHash == "" {
		// Set the password
		hash := hashPassword(body.Password)
		if err := db.SetSetting("auth_password_hash", hash); err != nil {
			authLogger.Error().Err(err).Msg("failed to save password hash")
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to set password"})
		}
		storedHash = hash
	}

	// Verify password
	if hashPassword(body.Password) != storedHash {
		return c.JSON(http.StatusUnauthorized, map[string]interface{}{
			"success": false,
			"error":   "Invalid password",
		})
	}

	// Create session token
	sessionToken := generateSessionToken()

	// Store session
	session := &db.Session{
		ID:        sessionToken,
		CreatedAt: db.NowUTC(),
	}
	// Note: We'd need to add a CreateSession function to db package

	// Set session cookie
	cookie := &http.Cookie{
		Name:     "session",
		Value:    sessionToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   c.Request().TLS != nil,
		MaxAge:   86400 * 30, // 30 days
	}
	c.SetCookie(cookie)

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success":   true,
		"sessionId": session.ID,
	})
}

// Logout handles POST /api/auth/logout
func Logout(c echo.Context) error {
	// Clear session cookie
	cookie := &http.Cookie{
		Name:     "session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	}
	c.SetCookie(cookie)

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success": true,
	})
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
