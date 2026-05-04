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

// appEnvKeys lists all environment variables that the application reads at
// startup. After the config is loaded and the server is initialised, these are
// cleared from the process environment so that sensitive values (API keys,
// OAuth secrets, etc.) are not visible via /proc/self/environ or printenv.
var appEnvKeys = []string{
	// Server
	"PORT", "HOST", "NODE_ENV",
	// Data directories
	"USER_DATA_DIR", "APP_DATA_DIR", "MLD_SIMPLE_EXTENSION_DIR",
	// Host directory mounts (Docker)
	"HOST_USER_DATA_DIR", "HOST_APP_DATA_DIR", "HOST_CLAUDE_DIR",
	"HOST_CODEX_DIR", "HOST_CONFIG_DIR", "HOST_GEMINI_DIR",
	"HOST_OPENCODE_DIR", "HOST_QWEN_DIR", "HOST_SSH_DIR",
	// OAuth
	"MLD_AUTH_MODE", "MLD_OAUTH_CLIENT_ID", "MLD_OAUTH_CLIENT_SECRET",
	"MLD_OAUTH_ISSUER_URL", "MLD_OAUTH_REDIRECT_URI", "MLD_EXPECTED_USERNAME",
	// Agent LLM gateway
	"AGENT_BASE_URL", "AGENT_API_KEY", "AGENT_CUSTOMER_ID", "AGENT_MODELS",
	// ANTHROPIC_* (deployment mirrors AGENT_* for agent child processes)
	"ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
	// OPENAI_* (deployment mirrors AGENT_* for agent child processes)
	"OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
	// Agent home/config dirs (read by server.New)
	"CODEX_HOME", "GEMINI_HOME", "QWEN_HOME", "OPENCODE_CONFIG",
	// Other app vars
	"USERNAME", "HAID_BASE_URL", "MLD_LLM_ANTHROPIC_KEY",
	// Debug
	"DB_LOG_QUERIES", "DEBUG",
}

// ClearEnvVars removes all application environment variables from the process.
// Call this after config is loaded and server initialisation is complete so
// that sensitive values (API keys, OAuth secrets) are no longer visible in
// /proc/self/environ or via printenv. Values remain accessible through the
// Config struct in memory.
func ClearEnvVars() {
	for _, key := range appEnvKeys {
		os.Unsetenv(key)
	}
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
