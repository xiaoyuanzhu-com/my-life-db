package auth

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"golang.org/x/oauth2"
)

// OIDCProvider wraps the OIDC provider with caching
type OIDCProvider struct {
	provider     *oidc.Provider
	oauth2Config *oauth2.Config
	verifier     *oidc.IDTokenVerifier
	mu           sync.RWMutex
	lastFetch    time.Time
	cacheTTL     time.Duration
}

var (
	oidcProvider     *OIDCProvider
	oidcProviderOnce sync.Once
	oidcProviderErr  error
)

// GetOIDCProvider returns a singleton OIDC provider instance with discovery
func GetOIDCProvider() (*OIDCProvider, error) {
	oidcProviderOnce.Do(func() {
		cfg := config.Get()

		if cfg.OAuthIssuerURL == "" {
			oidcProviderErr = fmt.Errorf("OAuth issuer URL not configured")
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		// Discover OIDC provider configuration
		provider, err := oidc.NewProvider(ctx, cfg.OAuthIssuerURL)
		if err != nil {
			oidcProviderErr = fmt.Errorf("failed to discover OIDC provider: %w", err)
			log.Error().Err(err).Str("issuer", cfg.OAuthIssuerURL).Msg("OIDC provider discovery failed")
			return
		}

		// Create OAuth2 config with discovered endpoints
		oauth2Config := &oauth2.Config{
			ClientID:     cfg.OAuthClientID,
			ClientSecret: cfg.OAuthClientSecret,
			RedirectURL:  cfg.OAuthRedirectURI,
			Endpoint:     provider.Endpoint(),
			Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
		}

		// Create ID token verifier
		verifier := provider.Verifier(&oidc.Config{
			ClientID: cfg.OAuthClientID,
		})

		oidcProvider = &OIDCProvider{
			provider:     provider,
			oauth2Config: oauth2Config,
			verifier:     verifier,
			lastFetch:    time.Now(),
			cacheTTL:     1 * time.Hour,
		}

		log.Info().
			Str("issuer", cfg.OAuthIssuerURL).
			Str("auth_endpoint", provider.Endpoint().AuthURL).
			Str("token_endpoint", provider.Endpoint().TokenURL).
			Msg("OIDC provider discovered and configured")
	})

	return oidcProvider, oidcProviderErr
}

// GetAuthCodeURL returns the authorization URL for OAuth flow
func (p *OIDCProvider) GetAuthCodeURL(state string) string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.oauth2Config.AuthCodeURL(state)
}

// Exchange exchanges authorization code for tokens
func (p *OIDCProvider) Exchange(ctx context.Context, code string) (*oauth2.Token, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.oauth2Config.Exchange(ctx, code)
}

// VerifyIDToken verifies and parses an ID token
func (p *OIDCProvider) VerifyIDToken(ctx context.Context, rawIDToken string) (*oidc.IDToken, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.verifier.Verify(ctx, rawIDToken)
}

// TokenSource creates a token source for token refresh
func (p *OIDCProvider) TokenSource(ctx context.Context, token *oauth2.Token) oauth2.TokenSource {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.oauth2Config.TokenSource(ctx, token)
}
