package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
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

const (
	// oauthStateCookieName is the cookie name for storing OAuth state
	oauthStateCookieName = "oauth_state"
	// oauthNativeRedirectCookieName stores the native app redirect scheme during OAuth flow
	oauthNativeRedirectCookieName = "oauth_native_redirect"
	// oauthStateCookieMaxAge is the max age for the OAuth state cookie (5 minutes)
	oauthStateCookieMaxAge = 300
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
func (h *Handlers) OAuthAuthorize(c *gin.Context) {
	// Get OIDC provider with automatic discovery
	provider, err := auth.GetOIDCProvider()
	if err != nil {
		log.Error().Err(err).Msg("failed to get OIDC provider")
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "OAuth is not configured",
		})
		return
	}

	// Generate cryptographically random state parameter to prevent CSRF
	state, err := generateOAuthState()
	if err != nil {
		log.Error().Err(err).Msg("failed to generate OAuth state")
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Failed to initiate OAuth flow",
		})
		return
	}

	// Store state in a short-lived httpOnly cookie for validation on callback
	cfg := config.Get()
	secure := !cfg.IsDevelopment()
	c.SetCookie(oauthStateCookieName, state, oauthStateCookieMaxAge, "/api/oauth", "", secure, true)

	// If native app redirect is requested, store it in a cookie for the callback
	if nativeRedirect := c.Query("native_redirect"); nativeRedirect != "" {
		c.SetCookie(oauthNativeRedirectCookieName, nativeRedirect, oauthStateCookieMaxAge, "/api/oauth", "", secure, true)
	}

	// Get authorization URL with discovered endpoints
	authURL := provider.GetAuthCodeURL(state)

	c.Redirect(http.StatusFound, authURL)
}

// OAuthCallback handles GET /api/oauth/callback
func (h *Handlers) OAuthCallback(c *gin.Context) {
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

	// Validate state parameter to prevent CSRF attacks
	stateParam := c.Query("state")
	stateCookie, err := c.Cookie(oauthStateCookieName)
	if err != nil || stateCookie == "" {
		log.Warn().Msg("OAuth callback missing state cookie")
		c.Redirect(http.StatusFound, "/?error=invalid_state")
		return
	}

	// Clear the state cookie immediately
	c.SetCookie(oauthStateCookieName, "", -1, "/api/oauth", "", false, true)

	// Verify state matches
	if stateParam != stateCookie {
		log.Warn().
			Str("expected", stateCookie).
			Str("received", stateParam).
			Msg("OAuth state mismatch - possible CSRF attack")
		c.Redirect(http.StatusFound, "/?error=invalid_state")
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

	// Log token info for debugging
	log.Info().
		Bool("has_refresh_token", oauth2Token.RefreshToken != "").
		Int("expires_in", tokens.ExpiresIn).
		Msg("setting auth cookies")

	// Set session cookies
	setAuthCookiesGin(c, tokens)

	log.Info().
		Str("sub", claims.Sub).
		Str("username", username).
		Msg("OAuth login successful")

	// Check for native app redirect
	if nativeRedirect, err := c.Cookie(oauthNativeRedirectCookieName); err == nil && nativeRedirect != "" {
		// Clear the native redirect cookie
		c.SetCookie(oauthNativeRedirectCookieName, "", -1, "/api/oauth", "", false, true)

		// Build redirect URL with tokens for the native app
		redirectURL := fmt.Sprintf("%s?access_token=%s&expires_in=%d",
			nativeRedirect, url.QueryEscape(tokens.AccessToken), tokens.ExpiresIn)
		if tokens.RefreshToken != "" {
			redirectURL += "&refresh_token=" + url.QueryEscape(tokens.RefreshToken)
		}

		c.Redirect(http.StatusFound, redirectURL)
		return
	}

	// Redirect to home
	c.Redirect(http.StatusFound, "/")
}

// OAuthRefresh handles POST /api/oauth/refresh
func (h *Handlers) OAuthRefresh(c *gin.Context) {
	// Get refresh token from cookie
	refreshToken, err := c.Cookie("refresh_token")
	if err != nil || refreshToken == "" {
		log.Debug().
			Err(err).
			Str("cookies", c.Request.Header.Get("Cookie")).
			Msg("refresh token not found in cookie")
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "No refresh token provided",
		})
		return
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

	// Create an expired token with the refresh token
	// The oauth2 library uses the Expiry field to determine if refresh is needed
	token := &oauth2.Token{
		RefreshToken: refreshToken,
		Expiry:       time.Now().Add(-1 * time.Hour), // Set to past time to force refresh
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
		"success":       true,
		"expiresIn":     tokens.ExpiresIn,
		"access_token":  tokens.AccessToken,
		"refresh_token": tokens.RefreshToken,
	})
}

// OAuthToken handles GET /api/oauth/token
func (h *Handlers) OAuthToken(c *gin.Context) {
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

	// Get OIDC provider for token verification
	provider, err := auth.GetOIDCProvider()
	if err != nil {
		log.Error().Err(err).Msg("failed to get OIDC provider")
		c.JSON(http.StatusOK, gin.H{
			"authenticated": false,
			"error":         "oauth_not_configured",
		})
		return
	}

	// Verify the token using OIDC verifier
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	idToken, err := provider.VerifyIDToken(ctx, accessToken)
	if err != nil {
		log.Debug().Err(err).Msg("token validation failed")
		c.JSON(http.StatusOK, gin.H{
			"authenticated": false,
			"error":         "invalid_token",
		})
		return
	}

	// Extract claims
	var claims struct {
		Sub               string `json:"sub"`
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := idToken.Claims(&claims); err != nil {
		log.Error().Err(err).Msg("failed to parse token claims")
		c.JSON(http.StatusOK, gin.H{
			"authenticated": false,
			"error":         "invalid_token",
		})
		return
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
		c.JSON(http.StatusOK, gin.H{
			"authenticated": false,
			"error":         "unauthorized_user",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"authenticated": true,
		"username":      username,
		"sub":           claims.Sub,
		"email":         claims.Email,
	})
}

// OAuthLogout handles POST /api/oauth/logout
func (h *Handlers) OAuthLogout(c *gin.Context) {
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

	// Refresh token cookie - longer lived, path set to /api/oauth to be accessible by all OAuth endpoints
	if tokens.RefreshToken != "" {
		c.SetCookie("refresh_token", tokens.RefreshToken, 60*60*24*30, "/api/oauth", "", secure, true)
	}
}

func clearAuthCookiesGin(c *gin.Context) {
	c.SetCookie("access_token", "", -1, "/", "", false, true)
	c.SetCookie("refresh_token", "", -1, "/api/oauth", "", false, true)
}

// generateOAuthState generates a cryptographically random state string
func generateOAuthState() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}
