package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/api"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/server"
)

func main() {
	cfg := config.Get()

	// Create server config from app config
	serverCfg := &server.Config{
		Port:             cfg.Port,
		Host:             cfg.Host,
		Env:              cfg.Env,
		UserDataDir:      cfg.UserDataDir,
		AppDataDir:       cfg.AppDataDir,
		DatabasePath:     cfg.DatabasePath,
		FSScanInterval:   1 * time.Hour,
		FSWatchEnabled:   true,
		DigestWorkers:    3,
		DigestQueueSize:  1000,
		OpenAIAPIKey:     cfg.OpenAIAPIKey,
		OpenAIBaseURL:    cfg.OpenAIBaseURL,
		OpenAIModel:      cfg.OpenAIModel,
		HAIDBaseURL:      cfg.HAIDBaseURL,
		HAIDAPIKey:       cfg.HAIDAPIKey,
		HAIDChromeCDPURL: cfg.HAIDChromeCDPURL,
	}

	// Create server
	srv, err := server.New(serverCfg)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to create server")
	}

	// Initialize Claude Code manager
	if err := api.InitClaudeManager(); err != nil {
		log.Fatal().Err(err).Msg("failed to initialize claude manager")
	}

	// Setup API routes
	handlers := api.NewHandlers(srv)
	api.SetupRoutes(srv.Router(), handlers)

	// Setup static file serving and SPA fallback
	setupStaticRoutes(srv.Router())

	// Start server in background
	go func() {
		log.Info().Str("addr", fmt.Sprintf("%s:%d", serverCfg.Host, serverCfg.Port)).Msg("server starting")
		printNetworkAddresses(serverCfg.Port)

		if err := srv.Start(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server error")
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Info().Msg("shutting down server")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Shutdown Claude manager first (kills all sessions)
	if err := api.ShutdownClaudeManager(ctx); err != nil {
		log.Error().Err(err).Msg("claude manager shutdown error")
	}

	if err := srv.Shutdown(ctx); err != nil {
		log.Error().Err(err).Msg("server shutdown error")
	}

	log.Info().Msg("server stopped")
}

// setupStaticRoutes configures static file serving
func setupStaticRoutes(r *gin.Engine) {
	// Assets with content hash (immutable, cache for 1 year)
	r.GET("/assets/*filepath", serveImmutableAssets("frontend/dist/assets"))

	// Static files without hash (cache for 1 day, revalidate)
	r.GET("/static/*filepath", serveStaticAssets("frontend/dist/static"))

	// Individual static files
	r.GET("/favicon.ico", serveStaticFile("frontend/dist/favicon.ico", "image/x-icon"))
	r.GET("/manifest.webmanifest", serveStaticFile("frontend/dist/manifest.webmanifest", "application/manifest+json"))

	// SEO routes - must be before NoRoute to prevent SPA fallback
	r.GET("/robots.txt", serveRobotsTxt())
	r.GET("/sitemap.xml", serveSitemapXml())

	// SPA fallback - serve index.html for non-API routes
	// HTML should not be cached (or very short cache)
	r.NoRoute(func(c *gin.Context) {
		c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		c.Header("Pragma", "no-cache")
		c.Header("Expires", "0")
		c.File("frontend/dist/index.html")
	})

	// Note: /raw/*, /sqlar/* routes are registered in api.SetupRoutes()
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

// serveImmutableAssets serves assets with content hash (can be cached indefinitely)
func serveImmutableAssets(basePath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		filePath := c.Param("filepath")
		fullPath := filepath.Join(basePath, filePath)

		// Security: prevent path traversal
		if strings.Contains(filePath, "..") {
			c.Status(http.StatusForbidden)
			return
		}

		// Check if file exists
		if _, err := os.Stat(fullPath); os.IsNotExist(err) {
			c.Status(http.StatusNotFound)
			return
		}

		// Immutable assets with content hash can be cached for 1 year
		// "immutable" tells browsers this will never change
		c.Header("Cache-Control", "public, max-age=31536000, immutable")

		c.File(fullPath)
	}
}

// serveStaticAssets serves static assets without content hash (shorter cache)
func serveStaticAssets(basePath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		filePath := c.Param("filepath")
		fullPath := filepath.Join(basePath, filePath)

		// Security: prevent path traversal
		if strings.Contains(filePath, "..") {
			c.Status(http.StatusForbidden)
			return
		}

		// Check if file exists
		if _, err := os.Stat(fullPath); os.IsNotExist(err) {
			c.Status(http.StatusNotFound)
			return
		}

		// Static files without hash: cache for 1 day, but revalidate
		c.Header("Cache-Control", "public, max-age=86400, must-revalidate")

		c.File(fullPath)
	}
}

// serveStaticFile serves a specific static file with caching
func serveStaticFile(filePath string, contentType string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, err := os.Stat(filePath); os.IsNotExist(err) {
			c.Status(http.StatusNotFound)
			return
		}

		c.Header("Cache-Control", "public, max-age=86400, must-revalidate")
		if contentType != "" {
			c.Header("Content-Type", contentType)
		}
		c.File(filePath)
	}
}

// serveRobotsTxt serves the robots.txt file
func serveRobotsTxt() gin.HandlerFunc {
	return func(c *gin.Context) {
		robotsTxt := `User-agent: *
Allow: /

# Disallow API endpoints
Disallow: /api/
Disallow: /raw/
Disallow: /sqlar/
`
		c.Header("Content-Type", "text/plain; charset=utf-8")
		c.Header("Cache-Control", "public, max-age=86400")
		c.String(http.StatusOK, robotsTxt)
	}
}

// serveSitemapXml serves the sitemap.xml file
func serveSitemapXml() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Basic sitemap for SPA - just the homepage
		// In production, you might want to generate this dynamically
		sitemap := `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://my.xiaoyuanzhu.com/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`
		c.Header("Content-Type", "application/xml; charset=utf-8")
		c.Header("Cache-Control", "public, max-age=86400")
		c.String(http.StatusOK, sitemap)
	}
}
