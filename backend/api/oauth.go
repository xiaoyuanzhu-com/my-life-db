package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/xiaoyuanzhu-com/my-life-db/auth"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var oauthLogger = log.GetLogger("ApiOAuth")

// TokenResponse represents the OAuth token response
type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	RefreshToken string `json:"refresh_token,omitempty"`
	IDToken      string `json:"id_token,omitempty"`
}

// OAuthAuthorize handles GET /api/oauth/authorize
func OAuthAuthorize(c echo.Context) error {
	cfg := config.Get()

	if cfg.OAuthIssuerURL == "" || cfg.OAuthClientID == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "OAuth is not configured",
		})
	}

	// Determine redirect URI
	redirectURI := cfg.OAuthRedirectURI
	if redirectURI == "" {
		redirectURI = c.Scheme() + "://" + c.Request().Host + "/api/oauth/callback"
	}

	// Build authorization URL
	params := url.Values{}
	params.Set("client_id", cfg.OAuthClientID)
	params.Set("response_type", "code")
	params.Set("scope", "openid profile email")
	params.Set("redirect_uri", redirectURI)

	authURL := cfg.OAuthIssuerURL + "/authorize?" + params.Encode()

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
			return c.Redirect(http.StatusFound, "/?error="+url.QueryEscape(errMsg))
		}
		return c.Redirect(http.StatusFound, "/?error=no_code")
	}

	cfg := config.Get()
	if cfg.OAuthIssuerURL == "" || cfg.OAuthClientID == "" || cfg.OAuthClientSecret == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "OAuth is not configured",
		})
	}

	// Determine redirect URI
	redirectURI := cfg.OAuthRedirectURI
	if redirectURI == "" {
		redirectURI = c.Scheme() + "://" + c.Request().Host + "/api/oauth/callback"
	}

	// Exchange code for tokens
	tokens, err := exchangeCodeForTokens(cfg.OAuthIssuerURL, cfg.OAuthClientID, cfg.OAuthClientSecret, code, redirectURI)
	if err != nil {
		oauthLogger.Error().Err(err).Msg("failed to exchange code for tokens")
		return c.Redirect(http.StatusFound, "/?error=token_exchange_failed")
	}

	// Validate the ID token
	var payload *auth.JWTPayload
	if tokens.IDToken != "" {
		payload, err = auth.ValidateJWT(tokens.IDToken)
		if err != nil {
			oauthLogger.Error().Err(err).Msg("failed to validate ID token")
			return c.Redirect(http.StatusFound, "/?error=invalid_token")
		}

		// Verify expected username
		username := auth.GetUsernameFromPayload(payload)
		if !auth.VerifyExpectedUsername(username) {
			oauthLogger.Warn().Str("username", username).Msg("username not allowed")
			return c.Redirect(http.StatusFound, "/?error=unauthorized_user")
		}
	} else if tokens.AccessToken != "" {
		// Fall back to access token validation
		payload, err = auth.ValidateJWT(tokens.AccessToken)
		if err != nil {
			oauthLogger.Error().Err(err).Msg("failed to validate access token")
			return c.Redirect(http.StatusFound, "/?error=invalid_token")
		}
	}

	// Set session cookies
	setAuthCookies(c, tokens)

	oauthLogger.Info().
		Str("sub", payload.Sub).
		Msg("OAuth login successful")

	// Redirect to home
	return c.Redirect(http.StatusFound, "/")
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
	if cfg.OAuthIssuerURL == "" || cfg.OAuthClientID == "" || cfg.OAuthClientSecret == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "OAuth is not configured",
		})
	}

	// Exchange refresh token for new tokens
	tokens, err := refreshTokens(cfg.OAuthIssuerURL, cfg.OAuthClientID, cfg.OAuthClientSecret, refreshToken)
	if err != nil {
		oauthLogger.Error().Err(err).Msg("failed to refresh tokens")
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "Token refresh failed",
		})
	}

	// Set new cookies
	setAuthCookies(c, tokens)

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success":   true,
		"expiresIn": tokens.ExpiresIn,
	})
}

// OAuthToken handles GET /api/oauth/token
func OAuthToken(c echo.Context) error {
	// Get access token from cookie or header
	accessToken := c.Request().Header.Get("Authorization")
	if strings.HasPrefix(accessToken, "Bearer ") {
		accessToken = strings.TrimPrefix(accessToken, "Bearer ")
	} else {
		cookie, err := c.Cookie("access_token")
		if err != nil || cookie.Value == "" {
			return c.JSON(http.StatusOK, map[string]interface{}{
				"authenticated": false,
			})
		}
		accessToken = cookie.Value
	}

	// Validate the token
	payload, err := auth.ValidateJWT(accessToken)
	if err != nil {
		oauthLogger.Debug().Err(err).Msg("token validation failed")
		return c.JSON(http.StatusOK, map[string]interface{}{
			"authenticated": false,
			"error":         "invalid_token",
		})
	}

	// Verify expected username
	username := auth.GetUsernameFromPayload(payload)
	if !auth.VerifyExpectedUsername(username) {
		return c.JSON(http.StatusOK, map[string]interface{}{
			"authenticated": false,
			"error":         "unauthorized_user",
		})
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"authenticated": true,
		"username":      username,
		"sub":           payload.Sub,
		"email":         payload.Email,
	})
}

// OAuthLogout handles POST /api/oauth/logout
func OAuthLogout(c echo.Context) error {
	// Clear auth cookies
	clearAuthCookies(c)

	return c.JSON(http.StatusOK, map[string]interface{}{
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

func setAuthCookies(c echo.Context, tokens *TokenResponse) {
	// Access token cookie - httpOnly, secure in production
	cfg := config.Get()
	secure := !cfg.IsDevelopment()

	accessCookie := &http.Cookie{
		Name:     "access_token",
		Value:    tokens.AccessToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   tokens.ExpiresIn,
	}
	c.SetCookie(accessCookie)

	// Refresh token cookie - longer lived
	if tokens.RefreshToken != "" {
		refreshCookie := &http.Cookie{
			Name:     "refresh_token",
			Value:    tokens.RefreshToken,
			Path:     "/api/oauth/refresh",
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteLaxMode,
			MaxAge:   60 * 60 * 24 * 30, // 30 days
		}
		c.SetCookie(refreshCookie)
	}
}

func clearAuthCookies(c echo.Context) {
	accessCookie := &http.Cookie{
		Name:     "access_token",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	}
	c.SetCookie(accessCookie)

	refreshCookie := &http.Cookie{
		Name:     "refresh_token",
		Value:    "",
		Path:     "/api/oauth/refresh",
		HttpOnly: true,
		MaxAge:   -1,
	}
	c.SetCookie(refreshCookie)
}
