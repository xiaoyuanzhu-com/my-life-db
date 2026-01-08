package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var settingsLogger = log.GetLogger("ApiSettings")

// GetSettings handles GET /api/settings
func GetSettings(c *gin.Context) {
	settings, err := db.GetAllSettings()
	if err != nil {
		settingsLogger.Error().Err(err).Msg("failed to get settings")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get settings"})
		return
	}

	c.JSON(http.StatusOK, settings)
}

// UpdateSettings handles PUT /api/settings
func UpdateSettings(c *gin.Context) {
	var updates map[string]string
	if err := c.ShouldBindJSON(&updates); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if err := db.UpdateSettings(updates); err != nil {
		settingsLogger.Error().Err(err).Msg("failed to update settings")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update settings"})
		return
	}

	// Return updated settings
	settings, err := db.GetAllSettings()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": "true"})
		return
	}

	c.JSON(http.StatusOK, settings)
}

// ResetSettings handles POST /api/settings
func ResetSettings(c *gin.Context) {
	if err := db.ResetSettings(); err != nil {
		settingsLogger.Error().Err(err).Msg("failed to reset settings")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset settings"})
		return
	}

	// Return default settings
	settings, err := db.GetAllSettings()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": "true"})
		return
	}

	c.JSON(http.StatusOK, settings)
}
