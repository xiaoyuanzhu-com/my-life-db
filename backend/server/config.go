package server

import (
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/workers/digest"
)

// Config holds server configuration
type Config struct {
	// Server infrastructure (immutable, requires restart)
	Port int
	Host string
	Env  string // "development" or "production"

	// Paths (immutable, requires restart)
	UserDataDir  string // User files (inbox, notes, etc.) - source of truth
	AppDataDir   string // App data (database, cache) - rebuildable
	DatabasePath string

	// SQLite simple FTS5 extension (wangfenjin/simple)
	SimpleExtensionPath string
	SimpleDictDir       string

	// FS settings (can be hot-reloaded)
	FSScanInterval time.Duration
	FSWatchEnabled bool

	// Digest settings (can be hot-reloaded)
	DigestWorkers   int
	DigestQueueSize int

	// External services (can be hot-reloaded)
	OpenAIAPIKey  string
	OpenAIBaseURL string
	OpenAIModel   string

	// Agent LLM
	AgentLLM AgentLLMConfig

	// Feature flags
	InboxAgentEnabled bool

	// OAuth settings
	AuthMode              string
	OAuthClientID         string
	OAuthClientSecret     string
	OAuthIssuerURL        string
	OAuthRedirectURI      string
	OAuthExpectedUsername string

	// Debug settings
	DBLogQueries bool
	DebugModules string
}

// IsDevelopment returns true if running in development mode
func (c *Config) IsDevelopment() bool {
	return c.Env != "production"
}

// ToDBConfig converts server config to database config
func (c *Config) ToDBConfig() db.Config {
	return db.Config{
		Path:             c.DatabasePath,
		MaxOpenConns:     5,
		MaxIdleConns:     2,
		ConnMaxLifetime:  0, // Never expire
		LogQueries:       c.DBLogQueries,
		ExtensionPath:    c.SimpleExtensionPath,
		ExtensionDictDir: c.SimpleDictDir,
	}
}

// ToFSConfig converts server config to filesystem service config
func (c *Config) ToFSConfig() fs.Config {
	return fs.Config{
		DataRoot:     c.UserDataDir,
		ScanInterval: c.FSScanInterval,
		WatchEnabled: c.FSWatchEnabled,
	}
}

// ToDigestConfig converts server config to digest worker config
func (c *Config) ToDigestConfig() digest.Config {
	return digest.Config{
		Workers:          c.DigestWorkers,
		QueueSize:        c.DigestQueueSize,
		OpenAIAPIKey:     c.OpenAIAPIKey,
		OpenAIBaseURL:    c.OpenAIBaseURL,
		OpenAIModel:      c.OpenAIModel,
	}
}

// AgentLLMConfig holds configuration for the agent LLM gateway.
type AgentLLMConfig struct {
	BaseURL    string
	APIKey     string
	CustomerID string
	Models     []AgentModelInfo
}

// AgentModelInfo describes an available model from the LLM gateway.
// Field names match the ACP config_option_update frame: value/name/description.
// Agents lists which agent types can use this model (e.g. ["claude_code", "codex"]).
// Empty/omitted means the model is available to all agents.
// ClaudeSmall optionally overrides ANTHROPIC_SMALL_FAST_MODEL when this model
// is active in a Claude Code session; empty means reuse Value.
type AgentModelInfo struct {
	Value       string   `json:"value"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Agents      []string `json:"agents,omitempty"`
	ClaudeSmall string   `json:"claude_small,omitempty"`
}

// SupportsAgent returns true if this model can be used by the given agent type.
// A model with no Agents restriction is available to all agents.
func (m AgentModelInfo) SupportsAgent(agentType string) bool {
	if len(m.Agents) == 0 {
		return true
	}
	for _, a := range m.Agents {
		if a == agentType {
			return true
		}
	}
	return false
}

// FilterModelsForAgent returns the subset of models that support the given agent type.
func FilterModelsForAgent(models []AgentModelInfo, agentType string) []AgentModelInfo {
	filtered := make([]AgentModelInfo, 0, len(models))
	for _, m := range models {
		if m.SupportsAgent(agentType) {
			filtered = append(filtered, m)
		}
	}
	return filtered
}

// HasAgentLLM returns true if an agent LLM gateway is configured.
func (c *AgentLLMConfig) HasAgentLLM() bool {
	return c.BaseURL != ""
}

