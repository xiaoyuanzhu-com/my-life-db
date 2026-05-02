package server

import (
	"context"
	cryptoRand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/agentrunner"
	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/connect"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/explore"
	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/hooks"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	mcppkg "github.com/xiaoyuanzhu-com/my-life-db/mcp"
	"github.com/xiaoyuanzhu-com/my-life-db/mcptools"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
	"github.com/xiaoyuanzhu-com/my-life-db/skills"
	"github.com/xiaoyuanzhu-com/my-life-db/workers/digest"
	"github.com/xiaoyuanzhu-com/my-life-db/workers/textindex"
)

// Server owns and coordinates all application components
type Server struct {
	cfg *Config

	// Components (owned by server)
	database        *db.DB
	fsService       *fs.Service
	digestWorker    *digest.Worker
	textIndexer *textindex.Indexer
	notifService    *notifications.Service
	agentClient     *agentsdk.Client
	explore         *explore.Service
	hookRegistry    *hooks.Registry
	cronHook        *hooks.CronHook
	fsHook          *hooks.FSHook
	agentRunner     *agentrunner.Runner
	mcpTools        *mcptools.Cache
	connectStore    *connect.Store

	// Central MCP server. Backed by a single Registry into which every
	// feature package (agentrunner, explore, ...) registers its tools at
	// server startup. Routes mount this at POST /api/mcp.
	mcpServer *mcppkg.Server

	// Ephemeral token for the internal MCP endpoint. Generated at startup,
	// passed to agents via ACP headers. The MCP HTTP handler validates this
	// token (when present).
	mcpToken string

	// Shutdown context - cancelled when server is shutting down.
	// Long-running handlers (WebSocket, SSE) should listen to this.
	shutdownCtx    context.Context
	shutdownCancel context.CancelFunc

	// HTTP
	router *gin.Engine
	http   *http.Server
}

// New creates a new server with all components initialized
func New(cfg *Config) (*Server, error) {
	ctx, cancel := context.WithCancel(context.Background())

	// Generate ephemeral token for internal MCP endpoints
	tokenBytes := make([]byte, 32)
	cryptoRand.Read(tokenBytes)

	s := &Server{
		cfg:            cfg,
		mcpToken:       hex.EncodeToString(tokenBytes),
		shutdownCtx:    ctx,
		shutdownCancel: cancel,
	}

	// 1. Open database
	log.Info().Msg("initializing database")
	dbCfg := cfg.ToDBConfig()
	database, err := db.Open(dbCfg)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	s.database = database

	// Install bundled skills for agent discovery
	skills.Install(cfg.UserDataDir)

	// Note: skills.InstallClientConfig (writes .mcp.json) runs after the MCP
	// registry is populated below.

	// 1.5. Initialize explore service
	s.explore = explore.NewService(cfg.UserDataDir)

	// 1.6. Initialize Agent Client (ACP-based)
	{
		ccEnv := map[string]string{}
		codexEnv := map[string]string{}
		qwenEnv := map[string]string{}
		geminiEnv := map[string]string{}
		if cfg.AgentLLM.HasAgentLLM() {
			ccEnv["ANTHROPIC_BASE_URL"] = cfg.AgentLLM.BaseURL
			ccEnv["ANTHROPIC_API_KEY"] = cfg.AgentLLM.APIKey
			if cfg.AgentLLM.CustomerID != "" {
				ccEnv["ANTHROPIC_CUSTOM_HEADERS"] = "x-litellm-customer-id: " + cfg.AgentLLM.CustomerID
			}
			// Set default model from AGENT_MODELS (filtered per agent type) so the
			// agent doesn't use its built-in default (which may not exist on the gateway).
			if ccModels := FilterModelsForAgent(cfg.AgentLLM.Models, "claude_code"); len(ccModels) > 0 {
				defaultModel := ccModels[0].Value
				ccEnv["ANTHROPIC_MODEL"] = defaultModel
				smallModel := ccModels[0].ClaudeSmall
				if smallModel == "" {
					smallModel = defaultModel
				}
				ccEnv["ANTHROPIC_SMALL_FAST_MODEL"] = smallModel
			}

			codexEnv["OPENAI_BASE_URL"] = cfg.AgentLLM.BaseURL
			codexEnv["OPENAI_API_KEY"] = cfg.AgentLLM.APIKey
			if codexModels := FilterModelsForAgent(cfg.AgentLLM.Models, "codex"); len(codexModels) > 0 {
				codexEnv["OPENAI_MODEL"] = codexModels[0].Value
			}

			// TODO(qwen): no customer-ID header path yet; cfg.AgentLLM.CustomerID is
			// not propagated to Qwen sessions. Investigate qwen-cli env vars or config
			// file for custom HTTP headers.
			qwenEnv["OPENAI_BASE_URL"] = cfg.AgentLLM.BaseURL
			qwenEnv["OPENAI_API_KEY"] = cfg.AgentLLM.APIKey
			if qwenModels := FilterModelsForAgent(cfg.AgentLLM.Models, "qwen"); len(qwenModels) > 0 {
				qwenEnv["OPENAI_MODEL"] = qwenModels[0].Value
			}

			// gemini-cli v0.x+ supports GEMINI_CLI_CUSTOM_HEADERS
			// (google-gemini/gemini-cli#11893, merged 2025-11). Pass as a single
			// header line; only inject when a customer ID is configured.
			geminiEnv["GOOGLE_GEMINI_BASE_URL"] = cfg.AgentLLM.BaseURL
			geminiEnv["GEMINI_API_KEY"] = cfg.AgentLLM.APIKey
			if geminiModels := FilterModelsForAgent(cfg.AgentLLM.Models, "gemini"); len(geminiModels) > 0 {
				geminiEnv["GEMINI_MODEL"] = geminiModels[0].Value
			}
			if cfg.AgentLLM.CustomerID != "" {
				geminiEnv["GEMINI_CLI_CUSTOM_HEADERS"] = "x-litellm-customer-id: " + cfg.AgentLLM.CustomerID
			}
			// Write codex auth.json (forces auth_mode=apikey so it doesn't
			// try OAuth) and config.toml (injects x-litellm-customer-id
			// header when set; codex has no env var for custom HTTP headers).
			// Respect $CODEX_HOME if the operator set one; otherwise use the
			// default ~/.codex/. In local dev, run.js sets CODEX_HOME to a
			// repo-local folder so we don't clobber the developer's own config.
			codexHome := os.Getenv("CODEX_HOME")
			if codexHome == "" {
				if home, err := os.UserHomeDir(); err == nil {
					codexHome = filepath.Join(home, ".codex")
				}
			}
			if codexHome == "" {
				log.Warn().Msg("cannot resolve codex home directory; skipping codex config setup")
			} else if err := os.MkdirAll(codexHome, 0700); err != nil {
				log.Warn().Err(err).Str("path", codexHome).Msg("failed to create codex home")
			} else {
				authJSON := fmt.Sprintf(`{"auth_mode":"apikey","OPENAI_API_KEY":%q,"tokens":null,"last_refresh":null}`, cfg.AgentLLM.APIKey)
				authPath := filepath.Join(codexHome, "auth.json")
				if err := os.WriteFile(authPath, []byte(authJSON), 0600); err != nil {
					log.Warn().Err(err).Str("path", authPath).Msg("failed to write codex auth.json")
				}
				configPath := filepath.Join(codexHome, "config.toml")
				if cfg.AgentLLM.CustomerID != "" {
					configTOML := fmt.Sprintf(`model_provider = "litellm"

[model_providers.litellm]
name = "litellm"
base_url = %q
wire_api = "responses"
env_key = "OPENAI_API_KEY"
http_headers = { "x-litellm-customer-id" = %q }
`, cfg.AgentLLM.BaseURL+"/v1", cfg.AgentLLM.CustomerID)
					if err := os.WriteFile(configPath, []byte(configTOML), 0600); err != nil {
						log.Warn().Err(err).Str("path", configPath).Msg("failed to write codex config.toml")
					}
				} else {
					_ = os.Remove(configPath)
				}
			}

			// Write ~/.gemini/settings.json to force API-key auth. Without this,
			// gemini-cli defaults to oauth-personal and hits the ineligible-tier
			// geo check even when GEMINI_API_KEY is set. MyLifeDB fully owns
			// this file. Respect $GEMINI_HOME if set.
			geminiHome := os.Getenv("GEMINI_HOME")
			if geminiHome == "" {
				if home, err := os.UserHomeDir(); err == nil {
					geminiHome = filepath.Join(home, ".gemini")
				}
			}
			if geminiHome != "" {
				if err := os.MkdirAll(geminiHome, 0700); err != nil {
					log.Warn().Err(err).Str("path", geminiHome).Msg("failed to create gemini home")
				} else {
					geminiSettings := map[string]any{
						"security": map[string]any{
							"auth": map[string]string{"selectedType": "gemini-api-key"},
						},
					}
					geminiSettingsPath := filepath.Join(geminiHome, "settings.json")
					if body, err := json.MarshalIndent(geminiSettings, "", "  "); err != nil {
						log.Warn().Err(err).Msg("failed to marshal gemini settings.json")
					} else if err := os.WriteFile(geminiSettingsPath, body, 0600); err != nil {
						log.Warn().Err(err).Str("path", geminiSettingsPath).Msg("failed to write gemini settings.json")
					}
				}
			}

			// Write ~/.qwen/settings.json. qwen-code (a gemini-cli fork) does not
			// honor GEMINI_CLI_CUSTOM_HEADERS; it only reads customHeaders from
			// its settings.json. MyLifeDB fully owns this file.
			// Respect $QWEN_HOME if set, same escape hatch as codex.
			qwenHome := os.Getenv("QWEN_HOME")
			if qwenHome == "" {
				if home, err := os.UserHomeDir(); err == nil {
					qwenHome = filepath.Join(home, ".qwen")
				}
			}
			if qwenHome != "" {
				if err := os.MkdirAll(qwenHome, 0700); err != nil {
					log.Warn().Err(err).Str("path", qwenHome).Msg("failed to create qwen home")
				} else {
					settings := map[string]any{}
					if cfg.AgentLLM.CustomerID != "" {
						settings["model"] = map[string]any{
							"generationConfig": map[string]any{
								"customHeaders": map[string]string{
									"x-litellm-customer-id": cfg.AgentLLM.CustomerID,
								},
							},
						}
					}
					qwenSettingsPath := filepath.Join(qwenHome, "settings.json")
					if body, err := json.MarshalIndent(settings, "", "  "); err != nil {
						log.Warn().Err(err).Msg("failed to marshal qwen settings.json")
					} else if err := os.WriteFile(qwenSettingsPath, body, 0600); err != nil {
						log.Warn().Err(err).Str("path", qwenSettingsPath).Msg("failed to write qwen settings.json")
					}
				}
			}

			// Write ~/.config/opencode/opencode.json. opencode has no env-var
			// path for provider options; the provider block (baseURL, apiKey,
			// headers, models) lives in JSON. MyLifeDB fully owns this file.
			// Respect $OPENCODE_CONFIG if set (opencode reads it when present).
			opencodeConfigPath := os.Getenv("OPENCODE_CONFIG")
			if opencodeConfigPath == "" {
				if home, err := os.UserHomeDir(); err == nil {
					opencodeConfigPath = filepath.Join(home, ".config", "opencode", "opencode.json")
				}
			}
			if opencodeConfigPath != "" {
				if err := os.MkdirAll(filepath.Dir(opencodeConfigPath), 0755); err != nil {
					log.Warn().Err(err).Str("path", opencodeConfigPath).Msg("failed to create opencode config dir")
				} else {
					providerOptions := map[string]any{
						"baseURL": cfg.AgentLLM.BaseURL,
						"apiKey":  cfg.AgentLLM.APIKey,
					}
					if cfg.AgentLLM.CustomerID != "" {
						providerOptions["headers"] = map[string]string{
							"x-litellm-customer-id": cfg.AgentLLM.CustomerID,
						}
					}
					models := map[string]any{}
					for _, m := range FilterModelsForAgent(cfg.AgentLLM.Models, "opencode") {
						models[m.Value] = map[string]string{"name": m.Name}
					}
					opencodeCfg := map[string]any{
						"$schema": "https://opencode.ai/config.json",
						"provider": map[string]any{
							"litellm": map[string]any{
								"npm":     "@ai-sdk/openai-compatible",
								"name":    "LiteLLM",
								"options": providerOptions,
								"models":  models,
							},
						},
					}
					if body, err := json.MarshalIndent(opencodeCfg, "", "  "); err != nil {
						log.Warn().Err(err).Msg("failed to marshal opencode.json")
					} else if err := os.WriteFile(opencodeConfigPath, body, 0600); err != nil {
						log.Warn().Err(err).Str("path", opencodeConfigPath).Msg("failed to write opencode.json")
					}
				}
			}
		}

		ccAgent := agentsdk.AgentConfig{
			Type:    agentsdk.AgentClaudeCode,
			Name:    "Claude Code",
			Command: "claude-agent-acp",
			Env:     ccEnv,
		}
		codexAgent := agentsdk.AgentConfig{
			Type:    agentsdk.AgentCodex,
			Name:    "Codex",
			Command: "codex-acp",
			Env:     codexEnv,
		}

		qwenAgent := agentsdk.AgentConfig{
			Type:    agentsdk.AgentQwen,
			Name:    "Qwen",
			Command: "qwen",
			Args:    []string{"--acp"},
			Env:     qwenEnv,
		}

		geminiAgent := agentsdk.AgentConfig{
			Type:    agentsdk.AgentGemini,
			Name:    "Gemini",
			Command: "gemini",
			Args:    []string{"--acp"},
			Env:     geminiEnv,
		}

		// opencode reads its provider config from ~/.config/opencode/opencode.json,
		// provisioned manually on the host. No env vars needed.
		opencodeAgent := agentsdk.AgentConfig{
			Type:    agentsdk.AgentOpencode,
			Name:    "opencode",
			Command: "opencode",
			Args:    []string{"acp"},
		}

		// SystemPrompt and McpServers are intentionally empty here — both are
		// built per-session in agent_manager.CreateSession so the X-MLD-Storage-Id
		// header and HTML-render path can carry the storage id.
		s.agentClient = agentsdk.NewClient(agentsdk.SessionConfig{}, ccAgent, codexAgent, qwenAgent, geminiAgent, opencodeAgent)

		// Configure each agent CLI to keep session transcripts forever.
		// Must run after the settings.json overwrites above, since some agents
		// share files (~/.gemini/settings.json, ~/.qwen/settings.json) and
		// retention is layered on via read-merge-write.
		agentsdk.EnsureRetentionConfigs()

		s.agentClient.StartPool(ctx, agentsdk.AgentClaudeCode, 3)

		log.Info().
			Bool("agent_llm", cfg.AgentLLM.HasAgentLLM()).
			Str("agent_base_url", cfg.AgentLLM.BaseURL).
			Int("agent_models", len(cfg.AgentLLM.Models)).
			Str("cc_model", ccEnv["ANTHROPIC_MODEL"]).
			Msg("agent client initialized")
	}

	// 1.7. Initialize hooks registry
	s.hookRegistry = hooks.NewRegistry()
	s.cronHook = hooks.NewCronHook(s.hookRegistry)
	s.fsHook = hooks.NewFSHook(s.hookRegistry)
	s.hookRegistry.Register(s.cronHook)
	s.hookRegistry.Register(s.fsHook)

	// 1.8. Initialize agent runner
	agentsDir := filepath.Join(cfg.UserDataDir, "agents")
	s.agentRunner = agentrunner.New(agentrunner.Config{
		AgentsDir:  agentsDir,
		Registry:   s.hookRegistry,
		CronHook:   s.cronHook,
		WorkingDir: cfg.UserDataDir,
	})

	// 1.9. Build the central MCP server. Each feature package registers its
	// tools into the shared registry; the Server wraps the registry as a
	// JSON-RPC HTTP handler mounted at /api/mcp.
	mcpRegistry := mcppkg.NewRegistry()
	agentrunner.RegisterTools(mcpRegistry, s.agentRunner, nil)
	explore.RegisterTools(mcpRegistry, s.explore)
	s.mcpServer = mcppkg.NewServer(mcpRegistry, s.mcpToken)

	// Register the built-in MCP server in <dataDir>/.mcp.json. That file is the
	// source of truth for both the composer UI and per-session McpServers
	// passed to ACP — built-in flows through the same path as user-added
	// servers; runtime-only headers (Authorization, X-MLD-Storage-Id) are
	// injected at session-creation time, not stored in the file.
	skills.InstallClientConfig(cfg.UserDataDir, cfg.Port)

	// 1.10. Initialize MCP tools cache. Probes registered MCP servers in
	// .mcp.json on first request and caches the result; invalidated by
	// fsnotify when .mcp.json is rewritten. The headers resolver injects
	// the ephemeral bearer token for our own localhost MCP endpoint
	// (mylifedb-builtin at /api/mcp) — that's server-owned and requires
	// auth that isn't stored in .mcp.json.
	internalPrefix := fmt.Sprintf("http://localhost:%d/api/", cfg.Port)
	s.mcpTools = mcptools.New(cfg.UserDataDir, func(spec mcptools.ServerSpec) map[string]string {
		if spec.Type == "http" && strings.HasPrefix(spec.URL, internalPrefix) {
			return map[string]string{"Authorization": "Bearer " + s.mcpToken}
		}
		return nil
	})

	// 2. Load user settings from database and apply log level
	settings, err := db.LoadUserSettings()
	if err == nil && settings.Preferences.LogLevel != "" {
		log.SetLevel(settings.Preferences.LogLevel)
		log.Info().Str("level", settings.Preferences.LogLevel).Msg("log level set from settings")
	}

	// 3. Create notifications service
	log.Info().Msg("initializing notifications service")
	s.notifService = notifications.NewService()

	// 4. Create FS service
	log.Info().Msg("initializing filesystem service")
	fsCfg := cfg.ToFSConfig()
	fsCfg.DB = fs.NewDBAdapter(s.database) // Inject database adapter
	fsCfg.PreviewNotifier = func(filePath, previewType string) {
		s.notifService.NotifyPreviewUpdated(filePath, previewType)
	}
	s.fsService = fs.NewService(fsCfg)

	// 5. Create digest worker
	log.Info().Msg("initializing digest worker")
	digestCfg := cfg.ToDigestConfig()
	s.digestWorker = digest.NewWorker(digestCfg, s.database)

	// 5.5. Create text indexer (writes synchronously to SQLite FTS5 files_fts)
	log.Info().Msg("initializing text indexer")
	s.textIndexer = textindex.NewIndexer(s.fsService.DataRoot(), s.database)

	// 7.5. MyLifeDB Connect store — third-party app authorization (OAuth 2.1
	// + PKCE). Schema is owned by db/migration_026_connect.go; this just
	// hands the connect package a *sql.DB handle.
	s.connectStore = connect.NewStore(s.database.Conn())

	// 8. Wire service connections
	s.connectServices()

	// 9. Setup HTTP router
	s.setupRouter()

	log.Info().Msg("server initialized successfully")
	return s, nil
}

// connectServices wires up event handlers between services
func (s *Server) connectServices() {
	// FS → Text Indexer + Digest: When files change, index for search and trigger digest processing
	s.fsService.SetFileChangeHandler(func(event fs.FileChangeEvent) {
		if event.ContentChanged {
			s.textIndexer.OnFileChange(event.FilePath, event.IsNew, true)
			s.digestWorker.OnFileChange(event.FilePath, event.IsNew, true)
		}

		// Emit file events to hooks registry for auto-run agents
		if event.IsNew {
			s.fsHook.EmitFileEvent(hooks.EventFileCreated, map[string]any{
				"path":   event.FilePath,
				"name":   filepath.Base(event.FilePath),
				"folder": filepath.Dir(event.FilePath),
			})
		} else if event.ContentChanged {
			s.fsHook.EmitFileEvent(hooks.EventFileChanged, map[string]any{
				"path": event.FilePath,
				"name": filepath.Base(event.FilePath),
			})
		}
	})
}

// setupRouter creates and configures the Gin router
func (s *Server) setupRouter() {
	// Set Gin mode
	if !s.cfg.IsDevelopment() {
		gin.SetMode(gin.ReleaseMode)
	}

	// Create router
	s.router = gin.New()

	// Middleware
	s.router.Use(gin.Recovery())
	s.router.Use(log.GinLogger())

	// CORS for development
	if s.cfg.IsDevelopment() {
		s.router.Use(s.corsMiddleware())
	}

	// Security headers (production only)
	if !s.cfg.IsDevelopment() {
		s.router.Use(s.securityHeadersMiddleware())
	}

	// Gzip compression (skip SSE, WebSocket, and TUS upload endpoints)
	// Note: WithExcludedPathsRegexs is used for routes with dynamic parameters
	s.router.Use(gzip.Gzip(gzip.DefaultCompression,
		gzip.WithExcludedPaths([]string{
			"/api/notifications/stream", // SSE - needs streaming
			"/api/asr/realtime",         // WebSocket - protocol upgrade
			"/api/upload/tus/",          // TUS - needs ResponseController for timeout extension
		}),
		gzip.WithExcludedPathsRegexs([]string{
			"/api/agent/sessions/.*/subscribe",  // WebSocket - agent session updates
		}),
	))

	// Trust proxy headers
	s.router.SetTrustedProxies(nil)

	// Note: unmatched /.well-known/* requests are 404'd by the NoRoute
	// handler in main.go (so they don't fall through to the SPA). We
	// can't register a wildcard here because specific routes like
	// /.well-known/oauth-authorization-server need to coexist.

	// Note: API routes should be set up by calling code (main.go)
	// to avoid import cycles
}

// corsMiddleware handles CORS for development environments
func (s *Server) corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")
		allowedOrigins := map[string]bool{
			"http://localhost:12345": true,
			"http://localhost:12346": true,
		}

		if allowedOrigins[origin] {
			c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
		}

		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Origin, Content-Type, Accept, Authorization, Upload-Offset, Upload-Length, Upload-Metadata, Tus-Resumable, X-Requested-With, Idempotency-Key")
		c.Writer.Header().Set("Access-Control-Expose-Headers", "Upload-Offset, Upload-Length, Location, Tus-Resumable")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		c.Next()
	}
}

// securityHeadersMiddleware adds security headers for production
func (s *Server) securityHeadersMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// HSTS - enforce HTTPS for 1 year, include subdomains
		c.Header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

		// Prevent MIME type sniffing
		c.Header("X-Content-Type-Options", "nosniff")

		// XSS protection (legacy, but still useful for older browsers)
		c.Header("X-XSS-Protection", "1; mode=block")

		// Clickjacking protection
		c.Header("X-Frame-Options", "SAMEORIGIN")

		// Cross-Origin-Opener-Policy for origin isolation
		c.Header("Cross-Origin-Opener-Policy", "same-origin")

		// Referrer policy - don't leak full URLs to other origins
		c.Header("Referrer-Policy", "strict-origin-when-cross-origin")

		// Permissions policy - disable unnecessary features
		c.Header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")

		c.Next()
	}
}

// Start starts all background services and the HTTP server
func (s *Server) Start() error {
	log.Info().Msg("starting server components")

	// Start FS service
	if err := s.fsService.Start(); err != nil {
		return fmt.Errorf("failed to start FS service: %w", err)
	}

	// Start digest worker
	go s.digestWorker.Start()

	// Backfill the FTS5 index for any files that aren't yet indexed.
	go s.textIndexer.Backfill()

	// Start hooks registry
	if err := s.hookRegistry.Start(s.shutdownCtx); err != nil {
		log.Error().Err(err).Msg("failed to start hooks registry")
	}

	// Start agent runner
	if err := s.agentRunner.Start(s.shutdownCtx); err != nil {
		log.Error().Err(err).Msg("failed to start agent runner")
	}

	// Start MCP tools cache (.mcp.json fsnotify watcher).
	if err := s.mcpTools.Start(s.shutdownCtx); err != nil {
		log.Error().Err(err).Msg("failed to start mcp tools cache")
	}

	// Start background sweep of stale agent-attachment staging dirs.
	go s.runAttachmentsJanitor()

	// Create HTTP server
	s.http = &http.Server{
		Addr:     fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port),
		Handler:  s.router,
		ErrorLog: log.StdErrorLogger(), // Route Go's internal HTTP errors through zerolog
	}

	log.Info().
		Str("addr", s.http.Addr).
		Str("env", s.cfg.Env).
		Msg("HTTP server starting")

	// Start HTTP server (blocks)
	return s.http.ListenAndServe()
}

// Shutdown gracefully shuts down the server using drain-then-shutdown.
// Sequence: signal sessions → close WS/SSE → close HTTP listener → drain active sessions → cleanup.
func (s *Server) Shutdown(ctx context.Context) error {
	log.Info().Msg("shutting down server")

	// 1. Cancel the shutdown context to signal all long-running handlers (WebSocket, SSE).
	// This must happen BEFORE http.Server.Shutdown() so that SSE/WS handlers exit
	// and release their connections — otherwise Shutdown() blocks waiting for them.
	log.Info().Msg("signaling handlers to stop")
	s.shutdownCancel()

	// 3. Close notification service to cleanly disconnect SSE clients
	s.notifService.Shutdown()

	// Give handlers a moment to process the cancellation and close connections.
	time.Sleep(100 * time.Millisecond)

	// 4. Stop accepting new HTTP connections and wait for in-flight requests to finish.
	if s.http != nil {
		httpCtx, httpCancel := context.WithTimeout(ctx, 5*time.Second)
		defer httpCancel()
		if err := s.http.Shutdown(httpCtx); err != nil {
			log.Error().Err(err).Msg("http server shutdown error")
		}
		log.Info().Msg("HTTP listener closed")
	}

	// 4.5. Stop agent runner + hooks (before agent client shutdown)
	if s.agentRunner != nil {
		s.agentRunner.Stop()
	}
	if s.mcpTools != nil {
		s.mcpTools.Stop()
	}
	if s.hookRegistry != nil {
		s.hookRegistry.Stop()
	}

	// 5. Shutdown agent client (close all ACP sessions + warm pool)
	if s.agentClient != nil {
		s.agentClient.ShutdownPool()
		if err := s.agentClient.Shutdown(ctx); err != nil {
			log.Error().Err(err).Msg("agent client shutdown error")
		}
	}

	// 6. Stop background services (in reverse order of startup)
	s.digestWorker.Stop()
	s.fsService.Stop()

	// 7. Close database last
	if s.database != nil {
		if err := s.database.Close(); err != nil {
			log.Error().Err(err).Msg("database close error")
			return err
		}
	}

	log.Info().Msg("server shutdown complete")
	return nil
}

// runAttachmentsJanitor runs hourly while the server is up, sweeping
// APP_DATA_DIR/tmp/agent-uploads/ for entries older than 30 days.
func (s *Server) runAttachmentsJanitor() {
	const (
		interval = 1 * time.Hour
		maxAge   = 30 * 24 * time.Hour
	)

	// Run once at startup so a long-stopped server still cleans up.
	if _, err := SweepAgentAttachments(s.cfg.AppDataDir, maxAge); err != nil {
		log.Error().Err(err).Msg("agent-attachments: initial sweep failed")
	}

	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-s.shutdownCtx.Done():
			return
		case <-t.C:
			if _, err := SweepAgentAttachments(s.cfg.AppDataDir, maxAge); err != nil {
				log.Error().Err(err).Msg("agent-attachments: sweep failed")
			}
		}
	}
}

// Component accessors for API handlers
func (s *Server) DB() *db.DB                                  { return s.database }
func (s *Server) FS() *fs.Service                             { return s.fsService }
func (s *Server) Digest() *digest.Worker                      { return s.digestWorker }
func (s *Server) TextIndexer() *textindex.Indexer            { return s.textIndexer }
func (s *Server) Notifications() *notifications.Service       { return s.notifService }
func (s *Server) AgentClient() *agentsdk.Client                { return s.agentClient }
func (s *Server) Explore() *explore.Service                      { return s.explore }
func (s *Server) HookRegistry() *hooks.Registry                  { return s.hookRegistry }
func (s *Server) FSHook() *hooks.FSHook                          { return s.fsHook }
func (s *Server) AgentRunner() *agentrunner.Runner               { return s.agentRunner }
func (s *Server) MCP() *mcppkg.Server                            { return s.mcpServer }
func (s *Server) MCPTools() *mcptools.Cache                      { return s.mcpTools }
func (s *Server) MCPToken() string                            { return s.mcpToken }
func (s *Server) Connect() *connect.Store                        { return s.connectStore }
func (s *Server) Cfg() *Config                               { return s.cfg }
func (s *Server) Router() *gin.Engine                         { return s.router }
func (s *Server) ShutdownContext() context.Context            { return s.shutdownCtx }

// SignalShutdown signals the server to begin shutting down early, before Shutdown() is called.
// This should be called immediately after receiving SIGINT/SIGTERM so that child processes
// (which share the process group and receive the signal simultaneously) are expected to exit.
func (s *Server) SignalShutdown() {
	// Agent client will be shut down in Shutdown()
}

// BuildAgentSystemPrompt returns the system prompt appended to agent sessions.
// dataDir is the user's data directory; storageID is the per-session storage
// id used to scope generated files.
func BuildAgentSystemPrompt(dataDir, storageID string) string {
	return `When the user asks for a chart, diagram, or visualization, return it as a fenced code block. The frontend auto-renders these — do not describe the output unless asked.

Two formats are supported:
- Mermaid code blocks for flowcharts, sequence diagrams, Gantt charts, ER diagrams, etc.
- HTML code blocks for anything richer or interactive (data-driven charts, styled layouts, computed tables). These render in a sandboxed iframe with scripts enabled.

Prefer mermaid when it can express the visualization. Use HTML when it cannot.

HTML output must be mobile-friendly and responsive — use relative units, flexbox/grid, and ensure readability on small screens.

## Large HTML visualizations (file-based)

When HTML output would exceed roughly 50 lines (complex dashboards, multi-slide presentations, data-heavy charts), do NOT inline it. Use the file-based approach instead:

1. Create the directory: mkdir -p ` + dataDir + `/sessions/` + storageID + `/generated
2. Write the full HTML to ` + dataDir + `/sessions/` + storageID + `/generated/<descriptive-name>.html using the Write tool
3. Return a small HTML code block wrapper that loads the file:

` + "```html" + `
<html>
<head><style>
  * { margin: 0; padding: 0; }
  body, html { width: 100%; height: 100%; overflow: hidden; }
  iframe { width: 100%; height: 100%; border: none; }
</style></head>
<body>
  <iframe src="/raw/sessions/` + storageID + `/generated/<descriptive-name>.html"></iframe>
</body>
</html>
` + "```" + `

IMPORTANT: Always write files to ` + dataDir + `/sessions/` + storageID + `/generated/ (absolute path). The iframe src must use /raw/sessions/` + storageID + `/generated/ (the /raw/ endpoint serves files relative to the data directory).

This keeps the LLM response small (saving tokens and latency) while the frontend renders the full visualization by loading it from the server via the /raw/ endpoint.

Use descriptive filenames: dashboard-sleep-trends.html, report-quarterly.html, chart-activity-by-month.html.

**Versioning rule:** When the user asks to modify a previously generated HTML file, always write to a NEW file with a version suffix (e.g., -v2, -v3). Never overwrite the original — it is still referenced earlier in the conversation and must remain intact so the user can see what changed and why.

For small visualizations (under ~50 lines), inline HTML code blocks are fine — no need for a file.

## Auto-Run Agents

MyLifeDB supports auto-run agents — markdown files in the agents/ folder that define automated tasks. When a user wants to automate something (organize files, run backups, scheduled reports), help them create an agent definition.

Agent definitions are markdown files with YAML frontmatter:

` + "```" + `markdown
---
name: <display name>
agent: claude_code
trigger: <file.created|file.changed|file.moved|file.deleted|cron>
schedule: "<cron expression>"  # only if trigger is cron
enabled: true
---

<natural language instructions — the agent follows these when triggered>
` + "```" + `

The prompt below the frontmatter is where all logic lives — filtering, actions, reporting. There are no config-based filters; the agent decides whether to act based on the trigger context it receives.

Save agent files to: ` + dataDir + `/agents/<name>.md

The agent runner watches this folder and picks up changes automatically.

When relevant, suggest the user include instructions to use the publish-post tool to share results on the explore page.`
}
