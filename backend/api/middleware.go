package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/auth"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// AuthMiddleware returns a Gin middleware that enforces authentication
// based on the configured auth mode (none, password, oauth).
func (h *Handlers) AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Skip auth if not required
		if !auth.IsAuthRequired() {
			c.Next()
			return
		}

		// If a third-party app has authenticated via a MyLifeDB Connect
		// bearer token, the ConnectAuthMiddleware has already validated it
		// and stamped the gin context. Treat that as "authenticated" for
		// owner-level routes that the app's scope happens to permit; the
		// scope check (RequireConnectScope) runs at the route level.
		if IsConnectAuthenticated(c) {
			c.Next()
			return
		}

		// Check authentication based on mode
		if auth.IsOAuthEnabled() {
			if !validateOAuthToken(c) {
				RespondCoded(c, http.StatusUnauthorized, "AUTH_INVALID_TOKEN", "Unauthorized")
				c.Abort()
				return
			}
		} else if auth.IsPasswordAuthEnabled() {
			if h.ValidatePasswordSession(c) == nil {
				RespondCoded(c, http.StatusUnauthorized, "AUTH_INVALID_SESSION", "Unauthorized")
				c.Abort()
				return
			}
		}

		c.Next()
	}
}

// validateOAuthToken validates the OAuth access token from cookie or header
func validateOAuthToken(c *gin.Context) bool {
	// Get access token from Authorization header, query parameter, or cookie.
	// Query parameter is needed for WebSocket connections (cannot set custom headers).
	accessToken := c.Request.Header.Get("Authorization")
	if strings.HasPrefix(accessToken, "Bearer ") {
		accessToken = strings.TrimPrefix(accessToken, "Bearer ")
	} else if qt := c.Query("access_token"); qt != "" {
		accessToken = qt
	} else {
		var err error
		accessToken, err = c.Cookie("access_token")
		if err != nil || accessToken == "" {
			return false
		}
	}

	// Get OIDC provider for token verification
	provider, err := auth.GetOIDCProvider()
	if err != nil {
		log.Error().Err(err).Msg("failed to get OIDC provider for token validation")
		return false
	}

	// Verify the token
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	idToken, err := provider.VerifyIDToken(ctx, accessToken)
	if err != nil {
		log.Debug().Err(err).Msg("OAuth token validation failed")
		return false
	}

	// Extract claims for username verification
	var claims struct {
		Sub               string `json:"sub"`
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := idToken.Claims(&claims); err != nil {
		log.Error().Err(err).Msg("failed to parse token claims")
		return false
	}

	// Determine username
	username := claims.PreferredUsername
	if username == "" && claims.Email != "" {
		parts := strings.Split(claims.Email, "@")
		username = parts[0]
	}
	if username == "" {
		username = claims.Sub
	}

	// Verify expected username
	if !auth.VerifyExpectedUsername(username) {
		log.Warn().Str("username", username).Msg("OAuth token has unauthorized username")
		return false
	}

	// Store username in context for downstream handlers
	c.Set("username", username)
	c.Set("sub", claims.Sub)

	return true
}
