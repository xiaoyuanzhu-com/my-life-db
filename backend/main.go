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

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/xiaoyuanzhu-com/my-life-db/api"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
	"github.com/xiaoyuanzhu-com/my-life-db/workers/digest"
	"github.com/xiaoyuanzhu-com/my-life-db/workers/fs"
)

var logger = log.GetLogger("Server")

func main() {
	cfg := config.Get()

	// Initialize database
	_ = db.GetDB()
	logger.Info().Str("path", cfg.DatabasePath).Msg("database initialized")

	// Create Echo instance
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	// Trust proxy headers
	e.IPExtractor = echo.ExtractIPFromXFFHeader()

	// Middleware
	e.Use(middleware.Recover())
	e.Use(middleware.RequestID())

	// Conditional middleware based on environment
	if cfg.IsDevelopment() {
		e.Use(middleware.LoggerWithConfig(middleware.LoggerConfig{
			Format: "${time_rfc3339} ${method} ${uri} ${status} ${latency_human}\n",
		}))
	} else {
		// Production: enable compression
		e.Use(middleware.GzipWithConfig(middleware.GzipConfig{
			Level: 5,
		}))
	}

	// CORS for development
	if cfg.IsDevelopment() {
		e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
			AllowOrigins: []string{"http://localhost:3000", "http://localhost:12345"},
			AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodOptions},
			AllowHeaders: []string{echo.HeaderOrigin, echo.HeaderContentType, echo.HeaderAccept, echo.HeaderAuthorization},
		}))
	}

	// Ignore .well-known requests (Chrome DevTools, etc.)
	e.GET("/.well-known/*", func(c echo.Context) error {
		return c.NoContent(http.StatusNotFound)
	})

	// Setup routes
	api.SetupRoutes(e)

	// Serve static files from dist directory (built frontend)
	e.Static("/", "dist/client")
	e.Static("/static", "static")

	// SPA fallback - serve index.html for non-API routes
	e.GET("/*", func(c echo.Context) error {
		return c.File("dist/client/index.html")
	})

	// Start background workers
	logger.Info().Msg("starting background workers")
	fsWorker := fs.NewWorker(cfg.DataDir)
	digestWorker := digest.NewWorker()

	// Connect FS worker to digest worker
	fsWorker.SetFileChangeHandler(func(event fs.FileChangeEvent) {
		digestWorker.OnFileChange(event.FilePath, event.IsNew, event.ContentChanged)
	})

	go fsWorker.Start()
	go digestWorker.Start()

	// Start server
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	go func() {
		logger.Info().
			Str("addr", addr).
			Str("env", cfg.Env).
			Msg("server starting")

		// Print network addresses
		printNetworkAddresses(cfg.Port)

		if err := e.Start(addr); err != nil && err != http.ErrServerClosed {
			logger.Fatal().Err(err).Msg("server error")
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info().Msg("shutting down server")

	// Stop workers
	fsWorker.Stop()
	digestWorker.Stop()

	// Shutdown server with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := e.Shutdown(ctx); err != nil {
		logger.Error().Err(err).Msg("server shutdown error")
	}

	// Close database
	if err := db.Close(); err != nil {
		logger.Error().Err(err).Msg("database close error")
	}

	// Shutdown notification service
	notifications.GetService().Shutdown()

	logger.Info().Msg("server stopped")
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
			logger.Info().Str("url", addr).Msg("network")
		}
	}
}
