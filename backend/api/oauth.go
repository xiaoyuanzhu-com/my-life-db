package api

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/auth"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"golang.org/x/oauth2"
)

// TokenResponse represents the OAuth token response
type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	RefreshToken string `json:"refresh_token,omitempty"`
	IDToken      string `json:"id_token,omitempty"`
}

// OAuthAuthorize handles GET /api/oauth/authorize
func OAuthAuthorize(c *gin.Context) {
	// Get OIDC provider with automatic discovery
	provider, err := auth.GetOIDCProvider()
	if err != nil {
		log.Error().Err(err).Msg("failed to get OIDC provider")
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "OAuth is not configured",
		})
		return
	}

	// Generate state parameter (in production, store this in session)
	state := "state-token" // TODO: Generate random state and store in session

	// Get authorization URL with discovered endpoints
	authURL := provider.GetAuthCodeURL(state)

	c.Redirect(http.StatusFound, authURL)
}

// OAuthCallback handles GET /api/oauth/callback
func OAuthCallback(c *gin.Context) {
	code := c.Query("code")
	if code == "" {
		errMsg := c.Query("error")
		errDesc := c.Query("error_description")
		if errMsg != "" {
			log.Error().Str("error", errMsg).Str("description", errDesc).Msg("OAuth callback error")
			c.Redirect(http.StatusFound, "/?error="+url.QueryEscape(errMsg))
			return
		}
		c.Redirect(http.StatusFound, "/?error=no_code")
		return
	}

	// Get OIDC provider with automatic discovery
	provider, err := auth.GetOIDCProvider()
	if err != nil {
		log.Error().Err(err).Msg("failed to get OIDC provider")
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "OAuth is not configured",
		})
		return
	}

	// Exchange authorization code for tokens using discovered token endpoint
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	oauth2Token, err := provider.Exchange(ctx, code)
	if err != nil {
		log.Error().Err(err).Msg("failed to exchange code for tokens")
		c.Redirect(http.StatusFound, "/?error=token_exchange_failed")
		return
	}

	// Extract and verify ID token
	rawIDToken, ok := oauth2Token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		log.Error().Msg("no id_token in token response")
		c.Redirect(http.StatusFound, "/?error=no_id_token")
		return
	}

	// Verify ID token with OIDC verifier
	idToken, err := provider.VerifyIDToken(ctx, rawIDToken)
	if err != nil {
		log.Error().Err(err).Msg("failed to verify ID token")
		c.Redirect(http.StatusFound, "/?error=invalid_token")
		return
	}

	// Extract claims from ID token
	var claims struct {
		Sub               string `json:"sub"`
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := idToken.Claims(&claims); err != nil {
		log.Error().Err(err).Msg("failed to parse ID token claims")
		c.Redirect(http.StatusFound, "/?error=invalid_token")
		return
	}

	// Determine username from claims
	username := claims.PreferredUsername
	if username == "" && claims.Email != "" {
		parts := strings.Split(claims.Email, "@")
		username = parts[0]
	}
	if username == "" {
		username = claims.Sub
	}

	// Verify expected username (for single-user instances)
	if !auth.VerifyExpectedUsername(username) {
		log.Warn().Str("username", username).Msg("username not allowed")
		c.Redirect(http.StatusFound, "/?error=unauthorized_user")
		return
	}

	// Create TokenResponse for cookie setting
	tokens := &TokenResponse{
		AccessToken:  oauth2Token.AccessToken,
		TokenType:    oauth2Token.TokenType,
		RefreshToken: oauth2Token.RefreshToken,
		IDToken:      rawIDToken,
		ExpiresIn:    int(time.Until(oauth2Token.Expiry).Seconds()),
	}

	// Set session cookies
	setAuthCookiesGin(c, tokens)

	log.Info().
		Str("sub", claims.Sub).
		Str("username", username).
		Msg("OAuth login successful")

	// Redirect to home
	c.Redirect(http.StatusFound, "/")
}

// OAuthRefresh handles GET /api/oauth/refresh
func OAuthRefresh(c *gin.Context) {
	// Get refresh token from cookie or header
	refreshToken := c.Request.Header.Get("X-Refresh-Token")
	if refreshToken == "" {
		refreshToken, _ = c.Cookie("refresh_token")
		if refreshToken == "" {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "No refresh token provided",
			})
			return
		}
	}

	// Get OIDC provider
	provider, err := auth.GetOIDCProvider()
	if err != nil {
		log.Error().Err(err).Msg("failed to get OIDC provider")
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "OAuth is not configured",
		})
		return
	}

	// Create token source with refresh token
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	token := &oauth2.Token{
		RefreshToken: refreshToken,
	}

	tokenSource := provider.TokenSource(ctx, token)
	newToken, err := tokenSource.Token()
	if err != nil {
		log.Error().Err(err).Msg("failed to refresh tokens")
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Token refresh failed",
		})
		return
	}

	// Create TokenResponse
	tokens := &TokenResponse{
		AccessToken:  newToken.AccessToken,
		TokenType:    newToken.TokenType,
		RefreshToken: newToken.RefreshToken,
		ExpiresIn:    int(time.Until(newToken.Expiry).Seconds()),
	}
	if rawIDToken, ok := newToken.Extra("id_token").(string); ok {
		tokens.IDToken = rawIDToken
	}

	// Set new cookies
	setAuthCookiesGin(c, tokens)

	c.JSON(http.StatusOK, gin.H{
		"success":   true,
		"expiresIn": tokens.ExpiresIn,
	})
}

// OAuthToken handles GET /api/oauth/token
func OAuthToken(c *gin.Context) {
	// Get access token from cookie or header
	accessToken := c.Request.Header.Get("Authorization")
	if strings.HasPrefix(accessToken, "Bearer ") {
		accessToken = strings.TrimPrefix(accessToken, "Bearer ")
	} else {
		accessToken, _ = c.Cookie("access_token")
		if accessToken == "" {
			c.JSON(http.StatusOK, gin.H{
				"authenticated": false,
			})
			return
		}
	}

	// Validate the token
	payload, err := auth.ValidateJWT(accessToken)
	if err != nil {
		log.Debug().Err(err).Msg("token validation failed")
		c.JSON(http.StatusOK, gin.H{
			"authenticated": false,
			"error":         "invalid_token",
		})
		return
	}

	// Verify expected username
	username := auth.GetUsernameFromPayload(payload)
	if !auth.VerifyExpectedUsername(username) {
		c.JSON(http.StatusOK, gin.H{
			"authenticated": false,
			"error":         "unauthorized_user",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"authenticated": true,
		"username":      username,
		"sub":           payload.Sub,
		"email":         payload.Email,
	})
}

// OAuthLogout handles POST /api/oauth/logout
func OAuthLogout(c *gin.Context) {
	// Clear auth cookies
	clearAuthCookiesGin(c)

	c.JSON(http.StatusOK, gin.H{
		"success": true,
	})
}

// Helper functions

func setAuthCookiesGin(c *gin.Context, tokens *TokenResponse) {
	// Access token cookie - httpOnly, secure in production
	cfg := config.Get()
	secure := !cfg.IsDevelopment()

	c.SetCookie("access_token", tokens.AccessToken, tokens.ExpiresIn, "/", "", secure, true)

	// Refresh token cookie - longer lived
	if tokens.RefreshToken != "" {
		c.SetCookie("refresh_token", tokens.RefreshToken, 60*60*24*30, "/api/oauth/refresh", "", secure, true)
	}
}

func clearAuthCookiesGin(c *gin.Context) {
	c.SetCookie("access_token", "", -1, "/", "", false, true)
	c.SetCookie("refresh_token", "", -1, "/api/oauth/refresh", "", false, true)
}
