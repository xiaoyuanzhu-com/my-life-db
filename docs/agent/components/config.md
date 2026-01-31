# Configuration

Configuration is managed via environment variables and loaded once at startup as a singleton.

## Key Components

| Location | Purpose |
|----------|---------|
| `backend/config/config.go` | Configuration loading, singleton |

## Config Structure

```go
type Config struct {
    // Server settings
    Port int
    Host string
    Env  string  // "development" or "production"

    // Data directories
    UserDataDir string  // User files (inbox, notes, etc.) - source of truth
    AppDataDir  string  // App data (database, cache) - rebuildable

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
```

## Singleton Pattern

```go
var (
    cfg  *Config
    once sync.Once
)

// Get returns the global configuration (loaded once)
func Get() *Config {
    once.Do(func() {
        cfg = load()
    })
    return cfg
}
```

## Environment Variables Reference

### Server Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `12345` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server host |
| `ENV` | `development` | Environment (`development` or `production`) |

### Data Directories

| Variable | Default | Description |
|----------|---------|-------------|
| `USER_DATA_DIR` | `./data` | User files (inbox, notes) - source of truth |
| `APP_DATA_DIR` | `./.my-life-db` | App data (database, cache) - rebuildable |

Paths are converted to absolute paths on load.

### Meilisearch (Full-text Search)

| Variable | Default | Description |
|----------|---------|-------------|
| `MEILI_HOST` | - | Meilisearch URL (e.g., `http://localhost:7700`) |
| `MEILI_API_KEY` | - | Meilisearch API key |
| `MEILI_INDEX` | `mylifedb_files` | Index name |

### Qdrant (Vector Search)

| Variable | Default | Description |
|----------|---------|-------------|
| `QDRANT_HOST` | - | Qdrant URL (e.g., `http://localhost:6333`) |
| `QDRANT_API_KEY` | - | Qdrant API key (optional) |
| `QDRANT_COLLECTION` | `mylifedb_vectors` | Collection name |

### OpenAI

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | - | OpenAI API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API base URL (for compatible APIs) |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model name |

### HAID (Custom Services)

| Variable | Default | Description |
|----------|---------|-------------|
| `HAID_BASE_URL` | - | HAID service URL |
| `HAID_API_KEY` | - | HAID API key |
| `HAID_CHROME_CDP_URL` | - | Chrome CDP URL for screenshots |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `MLD_AUTH_MODE` | `none` | Auth mode: `none`, `password`, or `oauth` |
| `MLD_OAUTH_CLIENT_ID` | - | OAuth client ID |
| `MLD_OAUTH_CLIENT_SECRET` | - | OAuth client secret |
| `MLD_OAUTH_ISSUER_URL` | - | OIDC issuer URL |
| `MLD_OAUTH_REDIRECT_URI` | - | OAuth redirect URI |
| `MLD_EXPECTED_USERNAME` | - | Optional: restrict to specific username |

### Debug Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_LOG_QUERIES` | - | Set to `1` to log SQL queries |
| `DEBUG` | - | Debug module names |

## Helper Methods

```go
// Check if running in development mode
func (c *Config) IsDevelopment() bool {
    return c.Env != "production"
}

// Get user data directory
func (c *Config) GetUserDataDir() string {
    return c.UserDataDir
}

// Get app data directory
func (c *Config) GetAppDataDir() string {
    return c.AppDataDir
}

// Legacy method (use GetUserDataDir instead)
func (c *Config) GetDataRoot() string {
    return c.UserDataDir
}
```

## Usage

### In Backend Code

```go
import "github.com/xiaoyuanzhu-com/my-life-db/config"

func SomeFunction() {
    cfg := config.Get()

    if cfg.OpenAIAPIKey != "" {
        // Use OpenAI
    }

    if cfg.IsDevelopment() {
        // Development-only behavior
    }
}
```

### Local Development

Create a `.env` file in the project root:

```bash
# .env
PORT=12345
ENV=development
USER_DATA_DIR=./data
APP_DATA_DIR=./.my-life-db

# Optional services
MEILI_HOST=http://localhost:7700
QDRANT_HOST=http://localhost:6333
OPENAI_API_KEY=sk-...
```

Load with `run.sh` or manually:
```bash
source .env && go run .
```

## Adding New Configuration

1. **Add field to Config struct**:
   ```go
   type Config struct {
       // ...
       MyNewSetting string
   }
   ```

2. **Load from environment in load()**:
   ```go
   func load() *Config {
       return &Config{
           // ...
           MyNewSetting: getEnv("MY_NEW_SETTING", "default"),
       }
   }
   ```

3. **Document in CLAUDE.md** (Environment Variables section)

4. **Use in code**:
   ```go
   cfg := config.Get()
   if cfg.MyNewSetting != "" {
       // Use setting
   }
   ```

## Configuration Principles

From CLAUDE.md:

> **Respect User Configuration**
> 1. Honor user settings exactly as provided
> 2. User agency over assumptions - if a setting seems wrong, let the error surface
> 3. Explicit is better than implicit
> 4. Configuration is intentional - assume the user knows what they're doing

**DO**:
- Pass through configuration values with minimal normalization
- Trust errors will guide the user to fix their config
- Document requirements clearly

**DON'T**:
- Automatically "fix" or convert user-provided values
- Add complex parsing/transformation logic "for convenience"
- Silently fall back to different values than configured

## Files to Modify

| Task | Files |
|------|-------|
| Add configuration options | `backend/config/config.go` |
| Document new options | `CLAUDE.md` (Environment Variables section) |
