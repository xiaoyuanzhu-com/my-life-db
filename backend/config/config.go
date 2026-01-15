package config

import (
	"os"
	"path/filepath"
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

	// External services
	MeiliHost   string
	MeiliAPIKey string
	MeiliIndex  string

	QdrantHost       string
	QdrantAPIKey     string
	QdrantCollection string

	OpenAIAPIKey  string
	OpenAIBaseURL string
	OpenAIModel   string

	HAIDBaseURL      string
	HAIDAPIKey       string
	HAIDChromeCDPURL string

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

	return &Config{
		// Server
		Port: getEnvInt("PORT", 12345),
		Host: getEnv("HOST", "0.0.0.0"),
		Env:  getEnv("ENV", "development"), // Keep NODE_ENV for compatibility

		// Data
		UserDataDir:  userDataDir,
		AppDataDir:   appDataDir,
		DatabasePath: filepath.Join(appDataDir, "database.sqlite"),

		// Meilisearch
		MeiliHost:   getEnv("MEILI_HOST", ""),
		MeiliAPIKey: getEnv("MEILI_API_KEY", ""),
		MeiliIndex:  getEnv("MEILI_INDEX", "mylifedb_files"),

		// Qdrant
		QdrantHost:       getEnv("QDRANT_HOST", ""),
		QdrantAPIKey:     getEnv("QDRANT_API_KEY", ""),
		QdrantCollection: getEnv("QDRANT_COLLECTION", "mylifedb_vectors"),

		// OpenAI
		OpenAIAPIKey:  getEnv("OPENAI_API_KEY", ""),
		OpenAIBaseURL: getEnv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		OpenAIModel:   getEnv("OPENAI_MODEL", "gpt-4o-mini"),

		// HAID
		HAIDBaseURL:      getEnv("HAID_BASE_URL", ""),
		HAIDAPIKey:       getEnv("HAID_API_KEY", ""),
		HAIDChromeCDPURL: getEnv("HAID_CHROME_CDP_URL", ""),

		// OAuth
		AuthMode:              getEnv("MLD_AUTH_MODE", "none"),
		OAuthClientID:         getEnv("MLD_OAUTH_CLIENT_ID", ""),
		OAuthClientSecret:     getEnv("MLD_OAUTH_CLIENT_SECRET", ""),
		OAuthIssuerURL:        getEnv("MLD_OAUTH_ISSUER_URL", ""),
		OAuthRedirectURI:      getEnv("MLD_OAUTH_REDIRECT_URI", ""),
		OAuthExpectedUsername: getEnv("MLD_EXPECTED_USERNAME", ""),

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
