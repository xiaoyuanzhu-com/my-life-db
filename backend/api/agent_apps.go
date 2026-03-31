package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

// GetAgentApps handles GET /api/agent-apps - lists all published agent apps.
func (h *Handlers) GetAgentApps(c *gin.Context) {
	svc := h.server.AgentApps()
	if svc == nil {
		c.JSON(http.StatusOK, []any{})
		return
	}

	apps, err := svc.ListApps()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list agent apps"})
		return
	}

	c.JSON(http.StatusOK, apps)
}

// GetAgentAppFiles handles GET /api/agent-apps/:app - lists files in a specific app.
func (h *Handlers) GetAgentAppFiles(c *gin.Context) {
	svc := h.server.AgentApps()
	if svc == nil {
		c.JSON(http.StatusOK, []any{})
		return
	}

	app := c.Param("app")
	files, err := svc.ListFiles(app)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list files"})
		return
	}

	c.JSON(http.StatusOK, files)
}

// ServeAgentApp handles GET /apps/*path - serves agent app static files.
func (h *Handlers) ServeAgentApp(c *gin.Context) {
	path := c.Param("path")
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}

	// Security: prevent directory traversal
	if strings.Contains(path, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
		return
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.UserDataDir, "apps", path)

	// If path is just an app name (no file), try index.html
	info, err := os.Stat(fullPath)
	if err == nil && info.IsDir() {
		indexPath := filepath.Join(fullPath, "index.html")
		if _, err := os.Stat(indexPath); err == nil {
			fullPath = indexPath
			info, err = os.Stat(fullPath)
		} else {
			c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
			return
		}
	}

	if os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to access file"})
		return
	}

	// Detect MIME type and serve
	mimeType := utils.DetectMimeType(fullPath)
	c.Header("Content-Type", mimeType)
	c.Header("Cache-Control", "public, max-age=60") // Short cache, agent apps update frequently

	file, err := os.Open(fullPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open file"})
		return
	}
	defer file.Close()

	http.ServeContent(c.Writer, c.Request, filepath.Base(fullPath), info.ModTime(), file)
}
