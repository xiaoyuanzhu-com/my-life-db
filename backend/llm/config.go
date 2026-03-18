// Package llm provides a reverse-proxy LLM layer that injects credentials
// into upstream API requests. Agent processes call these endpoints with a
// dummy API key; the proxy replaces it with the real key before forwarding.
package llm

import (
	"crypto/rand"
	"encoding/hex"
	"os"
)

// ProviderConfig holds credentials for a single LLM provider.
type ProviderConfig struct {
	APIKey  string
	BaseURL string
}

// Config holds LLM proxy configuration for all providers.
type Config struct {
	Anthropic  ProviderConfig
	OpenAI     ProviderConfig
	ProxyToken string // ephemeral bearer token, generated at startup
}

// NewConfigFromEnv loads LLM config from environment variables.
// A random proxy token is generated each time — never written to disk.
func NewConfigFromEnv() Config {
	return Config{
		Anthropic: ProviderConfig{
			APIKey:  os.Getenv("MLD_LLM_ANTHROPIC_KEY"),
			BaseURL: getEnvDefault("MLD_LLM_ANTHROPIC_URL", "https://api.anthropic.com"),
		},
		OpenAI: ProviderConfig{
			APIKey:  os.Getenv("MLD_LLM_OPENAI_KEY"),
			BaseURL: getEnvDefault("MLD_LLM_OPENAI_URL", "https://api.openai.com"),
		},
		ProxyToken: generateToken(),
	}
}

// HasAnthropic returns true if Anthropic credentials are configured.
func (c Config) HasAnthropic() bool { return c.Anthropic.APIKey != "" }

// HasOpenAI returns true if OpenAI credentials are configured.
func (c Config) HasOpenAI() bool { return c.OpenAI.APIKey != "" }

func getEnvDefault(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

func generateToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// Fallback — should never happen
		return "fallback-token-" + hex.EncodeToString([]byte(os.Getenv("PORT")))
	}
	return hex.EncodeToString(b)
}
