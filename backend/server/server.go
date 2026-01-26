package server

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
	"github.com/xiaoyuanzhu-com/my-life-db/workers/digest"
)

// Server owns and coordinates all application components
type Server struct {
	cfg *Config

	// Components (owned by server)
	database     *db.DB
	fsService    *fs.Service
	digestWorker *digest.Worker
	notifService *notifications.Service

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
	s := &Server{
		cfg:            cfg,
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
	s.fsService = fs.NewService(fsCfg)

	// 5. Create digest worker
	log.Info().Msg("initializing digest worker")
	digestCfg := cfg.ToDigestConfig()
	s.digestWorker = digest.NewWorker(digestCfg, s.database, s.notifService)

	// 6. Wire service connections
	s.connectServices()

	// 7. Setup HTTP router
	s.setupRouter()

	log.Info().Msg("server initialized successfully")
	return s, nil
}

// connectServices wires up event handlers between services
func (s *Server) connectServices() {
	// FS → Digest: When files change, trigger digest processing
	s.fsService.SetFileChangeHandler(func(event fs.FileChangeEvent) {
		if event.ContentChanged {
			s.digestWorker.OnFileChange(event.FilePath, event.IsNew, true)
		}

		// Notify UI of file changes
		if event.IsNew || event.ContentChanged {
			s.notifService.NotifyInboxChanged()
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

	// Gzip compression (skip SSE and WebSocket endpoints)
	s.router.Use(gzip.Gzip(gzip.DefaultCompression, gzip.WithExcludedPaths([]string{
		"/api/notifications/stream", // SSE - needs streaming
		"/api/asr/realtime",         // WebSocket - protocol upgrade
	})))

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

// Shutdown gracefully shuts down the server
func (s *Server) Shutdown(ctx context.Context) error {
	log.Info().Msg("shutting down server")

	// 1. Cancel the shutdown context to signal all long-running handlers (WebSocket, SSE)
	// This allows them to stop gracefully before we close the HTTP server
	log.Info().Msg("signaling handlers to stop")
	s.shutdownCancel()

	// Give handlers a moment to process the cancellation and close connections.
	// This prevents "response.WriteHeader on hijacked connection" warnings.
	time.Sleep(100 * time.Millisecond)

	// 2. Close notification service to cleanly disconnect SSE clients
	s.notifService.Shutdown()

	// 3. Shutdown HTTP server (stop accepting new requests and wait for existing ones)
	if s.http != nil {
		if err := s.http.Shutdown(ctx); err != nil {
			log.Error().Err(err).Msg("http server shutdown error")
		}
	}

	// Stop background services (in reverse order of startup)
	s.digestWorker.Stop()
	s.fsService.Stop()

	// Close database last
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
func (s *Server) DB() *db.DB                             { return s.database }
func (s *Server) FS() *fs.Service                        { return s.fsService }
func (s *Server) Digest() *digest.Worker                 { return s.digestWorker }
func (s *Server) Notifications() *notifications.Service  { return s.notifService }
func (s *Server) Router() *gin.Engine                    { return s.router }
func (s *Server) ShutdownContext() context.Context       { return s.shutdownCtx }
