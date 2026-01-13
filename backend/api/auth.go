package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
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

	// If no password is set, create one
	if storedHash == "" {
		// Set the password
		hash := hashPassword(body.Password)
		if err := db.SetSetting("auth_password_hash", hash); err != nil {
			log.Error().Err(err).Msg("failed to save password hash")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to set password"})
			return
		}
		storedHash = hash
	}

	// Verify password
	if hashPassword(body.Password) != storedHash {
		c.JSON(http.StatusUnauthorized, gin.H{
			"success": false,
			"error":   "Invalid password",
		})
		return
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
	secure := c.Request.TLS != nil
	c.SetCookie("session", sessionToken, 86400*30, "/", "", secure, true)

	c.JSON(http.StatusOK, gin.H{
		"success":   true,
		"sessionId": session.ID,
	})
}

// Logout handles POST /api/auth/logout
func (h *Handlers) Logout(c *gin.Context) {
	// Clear session cookie
	c.SetCookie("session", "", -1, "/", "", false, true)

	c.JSON(http.StatusOK, gin.H{
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
