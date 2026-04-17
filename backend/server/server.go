package server

import (
	"context"
	cryptoRand "crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/agent"
	"github.com/xiaoyuanzhu-com/my-life-db/agent/appclient"
	"github.com/xiaoyuanzhu-com/my-life-db/agentrunner"
	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/explore"
	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/hooks"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
	"github.com/xiaoyuanzhu-com/my-life-db/skills"
	"github.com/xiaoyuanzhu-com/my-life-db/workers/digest"
	meiliworker "github.com/xiaoyuanzhu-com/my-life-db/workers/meili"
)

// Server owns and coordinates all application components
type Server struct {
	cfg *Config

	// Components (owned by server)
	database        *db.DB
	fsService       *fs.Service
	digestWorker    *digest.Worker
	meiliSyncWorker *meiliworker.SyncWorker
	meiliIndexer    *meiliworker.Indexer
	notifService    *notifications.Service
	agent               *agent.Agent
	agentClient     *agentsdk.Client
	explore         *explore.Service
	hookRegistry    *hooks.Registry
	cronHook        *hooks.CronHook
	fsHook          *hooks.FSHook
	agentRunner     *agentrunner.Runner

	// Ephemeral token for internal MCP endpoints. Generated at startup,
	// passed to agents via ACP headers. All internal MCP HTTP handlers
	// validate this token.
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

	// 1.5. Initialize explore service
	s.explore = explore.NewService(cfg.UserDataDir)

	// 1.6. Initialize Agent Client (ACP-based)
	{
		ccEnv := map[string]string{}
		codexEnv := map[string]string{}
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
			// Isolate Codex config dir so it doesn't pick up the user's
			// stored ChatGPT OAuth token (~/.codex/auth.json). Pre-seed with
			// auth_mode=apikey so Codex uses OPENAI_API_KEY against our gateway.
			codexHome := filepath.Join(cfg.AppDataDir, "codex-home")
			if err := os.MkdirAll(codexHome, 0700); err != nil {
				log.Warn().Err(err).Str("path", codexHome).Msg("failed to create isolated CODEX_HOME")
			} else {
				authJSON := fmt.Sprintf(`{"auth_mode":"apikey","OPENAI_API_KEY":%q,"tokens":null,"last_refresh":null}`, cfg.AgentLLM.APIKey)
				authPath := filepath.Join(codexHome, "auth.json")
				if err := os.WriteFile(authPath, []byte(authJSON), 0600); err != nil {
					log.Warn().Err(err).Str("path", authPath).Msg("failed to write codex auth.json")
				}
				// Clean up any stale config.toml from earlier attempts.
				_ = os.Remove(filepath.Join(codexHome, "config.toml"))
				codexEnv["CODEX_HOME"] = codexHome
			}
		}

		ccAgent := agentsdk.AgentConfig{
			Type:    agentsdk.AgentClaudeCode,
			Name:    "Claude Code",
			Command: "claude-agent-acp",
			Env:     ccEnv,
		}
		codexAgent := agentsdk.AgentConfig{
			Type:     agentsdk.AgentCodex,
			Name:     "Codex",
			Command:  "codex-acp",
			CleanEnv: true,
			Env:      codexEnv,
		}

		// Build MCP servers to pass via ACP (no .mcp.json discovery needed)
		var mcpServers []acp.McpServer
		mcpServers = append(mcpServers, acp.McpServer{
			Http: &acp.McpServerHttpInline{
				Name: "explore",
				Type: "http",
				Url:  fmt.Sprintf("http://localhost:%d/api/explore/mcp", cfg.Port),
				Headers: []acp.HttpHeader{
					{Name: "Authorization", Value: "Bearer " + s.mcpToken},
				},
			},
		})

		s.agentClient = agentsdk.NewClient(agentsdk.SessionConfig{
			SystemPrompt: buildAgentSystemPrompt(cfg.UserDataDir),
			McpServers:   mcpServers,
		}, ccAgent, codexAgent)
		s.agentClient.StartPool(ctx, agentsdk.AgentClaudeCode, 3)

		log.Info().
			Bool("agent_llm", cfg.AgentLLM.HasAgentLLM()).
			Str("agent_base_url", cfg.AgentLLM.BaseURL).
			Int("agent_models", len(cfg.AgentLLM.Models)).
			Str("cc_model", ccEnv["ANTHROPIC_MODEL"]).
			Int("mcp_servers", len(mcpServers)).
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
	fsCfg.DB = fs.NewDBAdapter() // Inject database adapter
	fsCfg.PreviewNotifier = func(filePath, previewType string) {
		s.notifService.NotifyPreviewUpdated(filePath, previewType)
	}
	s.fsService = fs.NewService(fsCfg)

	// 5. Create digest worker
	log.Info().Msg("initializing digest worker")
	digestCfg := cfg.ToDigestConfig()
	s.digestWorker = digest.NewWorker(digestCfg, s.database)

	// 5.5. Create Meilisearch sync worker
	log.Info().Msg("initializing meili sync worker")
	s.meiliSyncWorker = meiliworker.NewSyncWorker()
	s.meiliIndexer = meiliworker.NewIndexer(s.fsService.DataRoot(), s.meiliSyncWorker.Nudge)

	// 6. Create agent (if enabled)
	if cfg.InboxAgentEnabled {
		log.Info().Msg("initializing inbox agent")
		appClient := appclient.NewLocalClient(s.database.Conn(), s.fsService)
		llmClient := agent.NewOpenAILLMClient()
		s.agent = agent.NewAgent(appClient, llmClient)
	} else {
		log.Info().Msg("inbox agent disabled")
	}

	// 8. Wire service connections
	s.connectServices()

	// 9. Setup HTTP router
	s.setupRouter()

	log.Info().Msg("server initialized successfully")
	return s, nil
}

// connectServices wires up event handlers between services
func (s *Server) connectServices() {
	// FS → Meili Indexer + Digest: When files change, index for search and trigger digest processing
	s.fsService.SetFileChangeHandler(func(event fs.FileChangeEvent) {
		if event.ContentChanged {
			s.meiliIndexer.OnFileChange(event.FilePath, event.IsNew, true)
			s.digestWorker.OnFileChange(event.FilePath, event.IsNew, true)
		}

		// Notify UI of file changes
		if event.IsNew || event.ContentChanged {
			s.notifService.NotifyInboxChanged()
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

	// Digest → Meili Sync + Agent: When files finish processing, sync to Meilisearch and trigger agent
	s.digestWorker.SetCompletionHandler(func(filePath string, processed int, failed int) {
		// Always nudge Meilisearch sync worker after digest completion
		if processed > 0 {
			s.meiliSyncWorker.Nudge()
		}

		// Agent analysis only for inbox files
		if s.agent == nil || !strings.HasPrefix(filePath, "inbox/") {
			return
		}

		// Only trigger if at least one digest was successfully processed
		if processed == 0 {
			log.Debug().Str("path", filePath).Msg("no digests processed, skipping agent analysis")
			return
		}

		log.Info().Str("path", filePath).Int("processed", processed).Msg("triggering agent analysis")

		// Run agent analysis in background
		go func() {
			ctx := context.Background()
			resp, err := s.agent.AnalyzeFile(ctx, filePath)
			if err != nil {
				log.Error().Err(err).Str("path", filePath).Msg("agent analysis failed")
				return
			}

			log.Info().
				Str("path", filePath).
				Str("intentionType", resp.Intention.IntentionType).
				Str("suggestedFolder", resp.Intention.SuggestedFolder).
				Float64("confidence", resp.Intention.Confidence).
				Msg("agent analysis complete")

			// Notify UI of new intention
			s.notifService.NotifyInboxChanged()
		}()
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

	// Ignore .well-known requests
	s.router.GET("/.well-known/*path", func(c *gin.Context) {
		c.Status(http.StatusNotFound)
	})

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

	// Start Meilisearch sync worker
	s.meiliSyncWorker.Start()

	// Start Meilisearch indexer backfill
	go s.meiliIndexer.Backfill()

	// Start hooks registry
	if err := s.hookRegistry.Start(s.shutdownCtx); err != nil {
		log.Error().Err(err).Msg("failed to start hooks registry")
	}

	// Start agent runner
	if err := s.agentRunner.Start(s.shutdownCtx); err != nil {
		log.Error().Err(err).Msg("failed to start agent runner")
	}

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
	s.meiliSyncWorker.Stop()
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

// Component accessors for API handlers
func (s *Server) DB() *db.DB                                  { return s.database }
func (s *Server) FS() *fs.Service                             { return s.fsService }
func (s *Server) Digest() *digest.Worker                      { return s.digestWorker }
func (s *Server) MeiliSync() *meiliworker.SyncWorker          { return s.meiliSyncWorker }
func (s *Server) MeiliIndexer() *meiliworker.Indexer          { return s.meiliIndexer }
func (s *Server) Notifications() *notifications.Service       { return s.notifService }
func (s *Server) Agent() *agent.Agent                         { return s.agent }
func (s *Server) AgentClient() *agentsdk.Client                { return s.agentClient }
func (s *Server) Explore() *explore.Service                      { return s.explore }
func (s *Server) HookRegistry() *hooks.Registry                  { return s.hookRegistry }
func (s *Server) FSHook() *hooks.FSHook                          { return s.fsHook }
func (s *Server) AgentRunner() *agentrunner.Runner               { return s.agentRunner }
func (s *Server) MCPToken() string                            { return s.mcpToken }
func (s *Server) Cfg() *Config                               { return s.cfg }
func (s *Server) Router() *gin.Engine                         { return s.router }
func (s *Server) ShutdownContext() context.Context            { return s.shutdownCtx }

// SignalShutdown signals the server to begin shutting down early, before Shutdown() is called.
// This should be called immediately after receiving SIGINT/SIGTERM so that child processes
// (which share the process group and receive the signal simultaneously) are expected to exit.
func (s *Server) SignalShutdown() {
	// Agent client will be shut down in Shutdown()
}

// buildAgentSystemPrompt returns the system prompt appended to agent sessions.
// dataDir is the user's data directory, used for file-based visualization paths.
func buildAgentSystemPrompt(dataDir string) string {
	return `When the user asks for a chart, diagram, or visualization, return it as a fenced code block. The frontend auto-renders these — do not describe the output unless asked.

Two formats are supported:
- Mermaid code blocks for flowcharts, sequence diagrams, Gantt charts, ER diagrams, etc.
- HTML code blocks for anything richer or interactive (data-driven charts, styled layouts, computed tables). These render in a sandboxed iframe with scripts enabled.

Prefer mermaid when it can express the visualization. Use HTML when it cannot.

HTML output must be mobile-friendly and responsive — use relative units, flexbox/grid, and ensure readability on small screens.

## Large HTML visualizations (file-based)

When HTML output would exceed roughly 50 lines (complex dashboards, multi-slide presentations, data-heavy charts), do NOT inline it. Use the file-based approach instead:

1. Create the directory: mkdir -p ` + dataDir + `/.generated
2. Write the full HTML to ` + dataDir + `/.generated/<descriptive-name>.html using the Write tool
3. Return a small HTML code block wrapper that loads the file:

` + "```html" + `
<html>
<head><style>
  * { margin: 0; padding: 0; }
  body, html { width: 100%; height: 100%; overflow: hidden; }
  iframe { width: 100%; height: 100%; border: none; }
</style></head>
<body>
  <iframe src="/raw/.generated/<descriptive-name>.html"></iframe>
</body>
</html>
` + "```" + `

IMPORTANT: Always write files to ` + dataDir + `/.generated/ (absolute path). The iframe src must use /raw/.generated/ (the /raw/ endpoint serves files relative to the data directory).

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
