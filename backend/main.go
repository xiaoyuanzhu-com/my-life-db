package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/api"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
	"github.com/xiaoyuanzhu-com/my-life-db/workers/digest"
	"github.com/xiaoyuanzhu-com/my-life-db/workers/fs"
)

func main() {
	cfg := config.Get()

	// Initialize database
	_ = db.GetDB()
	log.Info().Str("path", cfg.DatabasePath).Msg("database initialized")

	// Load settings and apply log level
	settings, err := db.LoadUserSettings()
	if err == nil && settings.Preferences.LogLevel != "" {
		log.SetLevel(settings.Preferences.LogLevel)
		log.Info().Str("level", settings.Preferences.LogLevel).Msg("log level set from settings")
	}

	// Set Gin to release mode to disable its default debug logging
	// We use our own zerolog-based request logger instead
	gin.SetMode(gin.ReleaseMode)

	// Create Gin router
	r := gin.New()

	// Middleware
	r.Use(gin.Recovery())

	// Request logging middleware (uses zerolog)
	r.Use(log.GinLogger())

	// CORS for development
	if cfg.IsDevelopment() {
		r.Use(corsMiddleware())
	}

	// Trust proxy headers
	r.SetTrustedProxies(nil) // Trust all proxies, or set specific ones

	// Ignore .well-known requests (Chrome DevTools, etc.)
	r.GET("/.well-known/*path", func(c *gin.Context) {
		c.Status(http.StatusNotFound)
	})

	// Setup API routes
	api.SetupRoutes(r)

	// Serve static files from frontend dist directory (built frontend)
	// When running from root directory, paths are relative to root
	r.Static("/assets", "frontend/dist/assets")
	r.Static("/static", "frontend/dist/static")
	r.StaticFile("/favicon.ico", "frontend/dist/favicon.ico")
	r.StaticFile("/manifest.webmanifest", "frontend/dist/manifest.webmanifest")

	// SPA fallback - serve index.html for non-API routes
	r.NoRoute(func(c *gin.Context) {
		c.File("frontend/dist/index.html")
	})

	// Start background workers
	log.Info().Msg("starting background workers")
	fsWorker := fs.NewWorker(cfg.DataDir)
	digestWorker := digest.NewWorker()

	// Connect FS worker to digest worker
	// When files change on filesystem (new or content changed), trigger digest processing
	fsWorker.SetFileChangeHandler(func(event fs.FileChangeEvent) {
		// Trigger digest processing if content changed
		if event.ContentChanged {
			digestWorker.OnFileChange(event.FilePath, event.IsNew, true)
		}

		// Notify UI of file changes (for external file additions like AirDrop)
		// Only notify for new files or content changes
		if event.IsNew || event.ContentChanged {
			notifications.GetService().NotifyInboxChanged()
		}
	})

	go fsWorker.Start()
	go digestWorker.Start()

	// Create HTTP server
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	srv := &http.Server{
		Addr:    addr,
		Handler: r,
	}

	// Start server
	go func() {
		log.Info().
			Str("addr", addr).
			Str("env", cfg.Env).
			Msg("server starting")

		// Print network addresses
		printNetworkAddresses(cfg.Port)

		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server error")
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Info().Msg("shutting down server")

	// Stop workers first (they may hold db connections)
	fsWorker.Stop()
	digestWorker.Stop()

	// Shutdown notification service to close all SSE connections
	notifications.GetService().Shutdown()

	// Shutdown server with timeout to close remaining HTTP connections
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Error().Err(err).Msg("server shutdown error")
	}

	// Close database
	if err := db.Close(); err != nil {
		log.Error().Err(err).Msg("database close error")
	}

	log.Info().Msg("server stopped")
}

// corsMiddleware creates a CORS middleware for Gin
func corsMiddleware() gin.HandlerFunc {
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

func printNetworkAddresses(port int) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return
	}

	var addresses []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}

		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok {
				if ip4 := ipnet.IP.To4(); ip4 != nil {
					addresses = append(addresses, fmt.Sprintf("http://%s:%d", ip4.String(), port))
				}
			}
		}
	}

	if len(addresses) > 0 {
		for _, addr := range addresses {
			log.Info().Str("url", addr).Msg("network")
		}
	}
}
