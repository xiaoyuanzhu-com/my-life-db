package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/config"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/log"
)

var oauthLogger = log.GetLogger("ApiOAuth")

// OAuthAuthorize handles GET /api/oauth/authorize
func OAuthAuthorize(c echo.Context) error {
	cfg := config.Get()

	if cfg.OAuthIssuerURL == "" || cfg.OAuthClientID == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "OAuth is not configured",
		})
	}

	// Build authorization URL
	// This would typically redirect to the OAuth provider
	authURL := cfg.OAuthIssuerURL + "/authorize" +
		"?client_id=" + cfg.OAuthClientID +
		"&response_type=code" +
		"&scope=openid profile email" +
		"&redirect_uri=" + c.Scheme() + "://" + c.Request().Host + "/api/oauth/callback"

	return c.Redirect(http.StatusFound, authURL)
}

// OAuthCallback handles GET /api/oauth/callback
func OAuthCallback(c echo.Context) error {
	code := c.QueryParam("code")
	if code == "" {
		errMsg := c.QueryParam("error")
		errDesc := c.QueryParam("error_description")
		if errMsg != "" {
			oauthLogger.Error().Str("error", errMsg).Str("description", errDesc).Msg("OAuth callback error")
			return c.JSON(http.StatusBadRequest, map[string]string{
				"error":       errMsg,
				"description": errDesc,
			})
		}
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "No code provided"})
	}

	cfg := config.Get()
	if cfg.OAuthIssuerURL == "" || cfg.OAuthClientID == "" || cfg.OAuthClientSecret == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "OAuth is not configured",
		})
	}

	// TODO: Exchange code for token
	// This would typically:
	// 1. POST to token endpoint with code
	// 2. Validate the ID token
	// 3. Create a session
	// 4. Redirect to the app

	// For now, return a placeholder
	return c.JSON(http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "OAuth callback received",
		"code":    code,
	})
}

// OAuthRefresh handles GET /api/oauth/refresh
func OAuthRefresh(c echo.Context) error {
	// Get refresh token from cookie or header
	refreshToken := c.Request().Header.Get("X-Refresh-Token")
	if refreshToken == "" {
		cookie, err := c.Cookie("refresh_token")
		if err != nil || cookie.Value == "" {
			return c.JSON(http.StatusUnauthorized, map[string]string{
				"error": "No refresh token provided",
			})
		}
		refreshToken = cookie.Value
	}

	cfg := config.Get()
	if cfg.OAuthIssuerURL == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "OAuth is not configured",
		})
	}

	// TODO: Exchange refresh token for new access token
	// This would typically POST to the token endpoint

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "Token refresh placeholder",
	})
}

// OAuthToken handles GET /api/oauth/token
func OAuthToken(c echo.Context) error {
	// Return token info
	// This is typically used to check if the user is authenticated

	accessToken := c.Request().Header.Get("Authorization")
	if accessToken == "" {
		cookie, err := c.Cookie("access_token")
		if err != nil || cookie.Value == "" {
			return c.JSON(http.StatusOK, map[string]interface{}{
				"authenticated": false,
			})
		}
		accessToken = cookie.Value
	}

	// TODO: Validate token and return user info

	return c.JSON(http.StatusOK, map[string]interface{}{
		"authenticated": true,
		"token":         "present",
	})
}
