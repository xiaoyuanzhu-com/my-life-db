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

	HAIDBaseURL      string
	HAIDAPIKey       string
	HAIDChromeCDPURL string

	MeiliHost   string
	MeiliAPIKey string
	MeiliIndex  string

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
		Path:            c.DatabasePath,
		MaxOpenConns:    5,
		MaxIdleConns:    2,
		ConnMaxLifetime: 0, // Never expire
		LogQueries:      c.DBLogQueries,
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
		HAIDBaseURL:      c.HAIDBaseURL,
		HAIDAPIKey:       c.HAIDAPIKey,
		HAIDChromeCDPURL: c.HAIDChromeCDPURL,
	}
}

