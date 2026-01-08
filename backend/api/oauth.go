package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/auth"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
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
	cfg := config.Get()

	if cfg.OAuthIssuerURL == "" || cfg.OAuthClientID == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "OAuth is not configured",
		})
		return
	}

	// Determine redirect URI
	redirectURI := cfg.OAuthRedirectURI
	if redirectURI == "" {
		scheme := "http"
		if c.Request.TLS != nil {
			scheme = "https"
		}
		redirectURI = scheme + "://" + c.Request.Host + "/api/oauth/callback"
	}

	// Build authorization URL
	params := url.Values{}
	params.Set("client_id", cfg.OAuthClientID)
	params.Set("response_type", "code")
	params.Set("scope", "openid profile email")
	params.Set("redirect_uri", redirectURI)

	authURL := cfg.OAuthIssuerURL + "/authorize?" + params.Encode()

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

	cfg := config.Get()
	if cfg.OAuthIssuerURL == "" || cfg.OAuthClientID == "" || cfg.OAuthClientSecret == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "OAuth is not configured",
		})
		return
	}

	// Determine redirect URI
	redirectURI := cfg.OAuthRedirectURI
	if redirectURI == "" {
		scheme := "http"
		if c.Request.TLS != nil {
			scheme = "https"
		}
		redirectURI = scheme + "://" + c.Request.Host + "/api/oauth/callback"
	}

	// Exchange code for tokens
	tokens, err := exchangeCodeForTokens(cfg.OAuthIssuerURL, cfg.OAuthClientID, cfg.OAuthClientSecret, code, redirectURI)
	if err != nil {
		log.Error().Err(err).Msg("failed to exchange code for tokens")
		c.Redirect(http.StatusFound, "/?error=token_exchange_failed")
		return
	}

	// Validate the ID token
	var payload *auth.JWTPayload
	if tokens.IDToken != "" {
		payload, err = auth.ValidateJWT(tokens.IDToken)
		if err != nil {
			log.Error().Err(err).Msg("failed to validate ID token")
			c.Redirect(http.StatusFound, "/?error=invalid_token")
			return
		}

		// Verify expected username
		username := auth.GetUsernameFromPayload(payload)
		if !auth.VerifyExpectedUsername(username) {
			log.Warn().Str("username", username).Msg("username not allowed")
			c.Redirect(http.StatusFound, "/?error=unauthorized_user")
			return
		}
	} else if tokens.AccessToken != "" {
		// Fall back to access token validation
		payload, err = auth.ValidateJWT(tokens.AccessToken)
		if err != nil {
			log.Error().Err(err).Msg("failed to validate access token")
			c.Redirect(http.StatusFound, "/?error=invalid_token")
			return
		}
	}

	// Set session cookies
	setAuthCookiesGin(c, tokens)

	log.Info().
		Str("sub", payload.Sub).
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

	cfg := config.Get()
	if cfg.OAuthIssuerURL == "" || cfg.OAuthClientID == "" || cfg.OAuthClientSecret == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "OAuth is not configured",
		})
		return
	}

	// Exchange refresh token for new tokens
	tokens, err := refreshTokens(cfg.OAuthIssuerURL, cfg.OAuthClientID, cfg.OAuthClientSecret, refreshToken)
	if err != nil {
		log.Error().Err(err).Msg("failed to refresh tokens")
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Token refresh failed",
		})
		return
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

func exchangeCodeForTokens(issuerURL, clientID, clientSecret, code, redirectURI string) (*TokenResponse, error) {
	tokenURL := issuerURL + "/token"

	data := url.Values{}
	data.Set("grant_type", "authorization_code")
	data.Set("client_id", clientID)
	data.Set("client_secret", clientSecret)
	data.Set("code", code)
	data.Set("redirect_uri", redirectURI)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", tokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("failed to create token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to exchange code: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("token endpoint returned status %d", resp.StatusCode)
	}

	var tokens TokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokens); err != nil {
		return nil, fmt.Errorf("failed to decode token response: %w", err)
	}

	return &tokens, nil
}

func refreshTokens(issuerURL, clientID, clientSecret, refreshToken string) (*TokenResponse, error) {
	tokenURL := issuerURL + "/token"

	data := url.Values{}
	data.Set("grant_type", "refresh_token")
	data.Set("client_id", clientID)
	data.Set("client_secret", clientSecret)
	data.Set("refresh_token", refreshToken)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", tokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("failed to create refresh request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to refresh token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("token endpoint returned status %d", resp.StatusCode)
	}

	var tokens TokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokens); err != nil {
		return nil, fmt.Errorf("failed to decode token response: %w", err)
	}

	return &tokens, nil
}

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
