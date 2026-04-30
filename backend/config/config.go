package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
)

// Config holds all application configuration
type Config struct {
	// Server settings
	Port int
	Host string
	Env  string // "development" or "production"

	// Data directories
	UserDataDir string // User files (inbox, notes, etc.) - source of truth
	AppDataDir  string // App data (database, cache) - rebuildable

	// Database
	DatabasePath string

	// SQLite simple FTS5 extension (wangfenjin/simple).
	// SimpleExtensionPath: absolute path to libsimple.{so,dylib}
	// SimpleDictDir: directory containing jieba dict.utf8 + friends
	// Both are derived from MLD_SIMPLE_EXTENSION_DIR (defaults to <APP_DATA_DIR>/extensions)
	SimpleExtensionPath string
	SimpleDictDir       string

	// External services
	OpenAIAPIKey  string
	OpenAIBaseURL string
	OpenAIModel   string

	// OAuth settings
	AuthMode              string
	OAuthClientID         string
	OAuthClientSecret     string
	OAuthIssuerURL        string
	OAuthRedirectURI      string
	OAuthExpectedUsername string

	// Agent LLM (AGENT_* env vars — translated per agent type)
	AgentBaseURL    string // AGENT_BASE_URL — LLM gateway (e.g., litellm)
	AgentAPIKey     string // AGENT_API_KEY — gateway API key
	AgentCustomerID string // AGENT_CUSTOMER_ID — per-user ID for usage tracking
	AgentModels     string // AGENT_MODELS — JSON array of available models

	// Debug settings
	DBLogQueries bool
	DebugModules string
}

var (
	cfg  *Config
	once sync.Once
)

// Get returns the global configuration (singleton)
func Get() *Config {
	once.Do(func() {
		cfg = load()
	})
	return cfg
}

// load reads configuration from environment variables
func load() *Config {
	userDataDir := getEnv("USER_DATA_DIR", "./data")
	appDataDir := getEnv("APP_DATA_DIR", "./.my-life-db")

	// Convert to absolute paths
	if absPath, err := filepath.Abs(userDataDir); err == nil {
		userDataDir = absPath
	}
	if absPath, err := filepath.Abs(appDataDir); err == nil {
		appDataDir = absPath
	}

	// Resolve the simple FTS5 extension paths.
	// Default location: <APP_DATA_DIR>/extensions/{libsimple.so|libsimple.dylib}
	// Dict default: <APP_DATA_DIR>/extensions/dict
	extDir := getEnv("MLD_SIMPLE_EXTENSION_DIR", filepath.Join(appDataDir, "extensions"))
	if abs, err := filepath.Abs(extDir); err == nil {
		extDir = abs
	}
	libBase := "libsimple.so"
	if runtime.GOOS == "darwin" {
		libBase = "libsimple.dylib"
	}
	simpleExtPath := filepath.Join(extDir, libBase)
	simpleDictDir := filepath.Join(extDir, "dict")

	return &Config{
		// Server
		Port: getEnvInt("PORT", 12345),
		Host: getEnv("HOST", "0.0.0.0"),
		Env:  getEnv("ENV", "development"), // Keep NODE_ENV for compatibility

		// Data
		UserDataDir:  userDataDir,
		AppDataDir:   appDataDir,
		DatabasePath: filepath.Join(appDataDir, "database.sqlite"),

		// SQLite simple extension
		SimpleExtensionPath: simpleExtPath,
		SimpleDictDir:       simpleDictDir,

		// OpenAI
		OpenAIAPIKey:  getEnv("OPENAI_API_KEY", ""),
		OpenAIBaseURL: getEnv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		OpenAIModel:   getEnv("OPENAI_MODEL", "gpt-4o-mini"),

		// OAuth
		AuthMode:              getEnv("MLD_AUTH_MODE", "none"),
		OAuthClientID:         getEnv("MLD_OAUTH_CLIENT_ID", ""),
		OAuthClientSecret:     getEnv("MLD_OAUTH_CLIENT_SECRET", ""),
		OAuthIssuerURL:        getEnv("MLD_OAUTH_ISSUER_URL", ""),
		OAuthRedirectURI:      getEnv("MLD_OAUTH_REDIRECT_URI", ""),
		OAuthExpectedUsername: getEnv("MLD_EXPECTED_USERNAME", ""),

		// Agent LLM
		AgentBaseURL:    getEnv("AGENT_BASE_URL", ""),
		AgentAPIKey:     getEnv("AGENT_API_KEY", ""),
		AgentCustomerID: getEnv("AGENT_CUSTOMER_ID", ""),
		AgentModels:     getEnv("AGENT_MODELS", ""),

		// Debug
		DBLogQueries: getEnv("DB_LOG_QUERIES", "") == "1",
		DebugModules: getEnv("DEBUG", ""),
	}
}

// IsDevelopment returns true if running in development mode
func (c *Config) IsDevelopment() bool {
	return c.Env != "production"
}

// GetDataRoot returns the USER_DATA_DIR path (deprecated: use GetUserDataDir)
func (c *Config) GetDataRoot() string {
	return c.UserDataDir
}

// GetUserDataDir returns the user data directory path
func (c *Config) GetUserDataDir() string {
	return c.UserDataDir
}

// GetAppDataDir returns the app data directory path
func (c *Config) GetAppDataDir() string {
	return c.AppDataDir
}

// Helper functions

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if i, err := strconv.Atoi(value); err == nil {
			return i
		}
	}
	return defaultValue
}
