package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/models"
)

// GetSettings handles GET /api/settings
func (h *Handlers) GetSettings(c *gin.Context) {
	settings, err := h.server.AppDB().LoadUserSettings()
	if err != nil {
		log.Error().Err(err).Msg("failed to load settings")
		RespondCoded(c, http.StatusInternalServerError, "SETTINGS_LOAD_FAILED", "Failed to load settings")
		return
	}

	c.JSON(http.StatusOK, settings)
}

// UpdateSettings handles PUT /api/settings
func (h *Handlers) UpdateSettings(c *gin.Context) {
	var updates models.UserSettings
	if err := c.ShouldBindJSON(&updates); err != nil {
		log.Error().Err(err).Msg("failed to parse settings update")
		RespondCoded(c, http.StatusBadRequest, "SETTINGS_REQUEST_INVALID", "Invalid request body")
		return
	}

	// Load current settings
	current, err := h.server.AppDB().LoadUserSettings()
	if err != nil {
		log.Error().Err(err).Msg("failed to load current settings")
		RespondCoded(c, http.StatusInternalServerError, "SETTINGS_LOAD_FAILED", "Failed to load current settings")
		return
	}

	// Merge updates with current settings
	merged := mergeSettings(current, &updates)

	// Save merged settings
	if err := h.server.AppDB().SaveUserSettings(c.Request.Context(), merged); err != nil {
		log.Error().Err(err).Msg("failed to save settings")
		RespondCoded(c, http.StatusInternalServerError, "SETTINGS_SAVE_FAILED", "Failed to save settings")
		return
	}

	// Apply log level change immediately if it was updated
	if updates.Preferences.LogLevel != "" {
		log.SetLevel(merged.Preferences.LogLevel)
		log.Info().Str("level", merged.Preferences.LogLevel).Msg("log level updated")
	}

	c.JSON(http.StatusOK, merged)
}

// mergeSettings merges updates into current settings
func mergeSettings(current, updates *models.UserSettings) *models.UserSettings {
	merged := *current

	// Merge preferences
	if updates.Preferences.Theme != "" {
		merged.Preferences.Theme = updates.Preferences.Theme
	}
	if updates.Preferences.DefaultView != "" {
		merged.Preferences.DefaultView = updates.Preferences.DefaultView
	}
	if updates.Preferences.LogLevel != "" {
		merged.Preferences.LogLevel = updates.Preferences.LogLevel
	}
	if updates.Preferences.Language != nil {
		merged.Preferences.Language = updates.Preferences.Language
	}

	// Merge extraction
	merged.Extraction.AutoEnrich = updates.Extraction.AutoEnrich
	merged.Extraction.IncludeEntities = updates.Extraction.IncludeEntities
	merged.Extraction.IncludeSentiment = updates.Extraction.IncludeSentiment
	merged.Extraction.IncludeActionItems = updates.Extraction.IncludeActionItems
	merged.Extraction.IncludeRelatedEntries = updates.Extraction.IncludeRelatedEntries
	if updates.Extraction.MinConfidence > 0 {
		merged.Extraction.MinConfidence = updates.Extraction.MinConfidence
	}

	// Merge storage
	if updates.Storage.DataPath != "" {
		merged.Storage.DataPath = updates.Storage.DataPath
	}
	if updates.Storage.BackupPath != "" {
		merged.Storage.BackupPath = updates.Storage.BackupPath
	}
	merged.Storage.AutoBackup = updates.Storage.AutoBackup
	if updates.Storage.MaxFileSize > 0 {
		merged.Storage.MaxFileSize = updates.Storage.MaxFileSize
	}

	return &merged
}

// ResetSettings handles POST /api/settings
func (h *Handlers) ResetSettings(c *gin.Context) {
	// Parse request body to check for action
	var body map[string]string
	if err := c.ShouldBindJSON(&body); err != nil {
		RespondCoded(c, http.StatusBadRequest, "SETTINGS_REQUEST_INVALID", "Invalid request body")
		return
	}

	if body["action"] != "reset" {
		RespondCoded(c, http.StatusBadRequest, "SETTINGS_INVALID_ACTION", "Invalid action")
		return
	}

	if err := h.server.AppDB().ResetSettings(c.Request.Context()); err != nil {
		log.Error().Err(err).Msg("failed to reset settings")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset settings"})
		return
	}

	// Return default settings
	settings, err := h.server.AppDB().LoadUserSettings()
	if err != nil {
		log.Error().Err(err).Msg("failed to load settings after reset")
		c.JSON(http.StatusOK, gin.H{"success": true})
		return
	}

	c.JSON(http.StatusOK, settings)
}
