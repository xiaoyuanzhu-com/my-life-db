package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/apps"
)

// GetApps returns the full registry of supported apps.
func (h *Handlers) GetApps(c *gin.Context) {
	list, err := apps.LoadAll(apps.ContentFS(), apps.ContentDir)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"apps": list})
}

// GetApp returns a single app's registry entry plus its doc (if present).
func (h *Handlers) GetApp(c *gin.Context) {
	id := c.Param("id")
	detail, err := apps.LoadOne(apps.ContentFS(), apps.ContentDir, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "app not found"})
		return
	}
	c.JSON(http.StatusOK, detail)
}
