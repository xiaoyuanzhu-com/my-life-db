package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/models"
)

// GetSettings handles GET /api/settings
func (h *Handlers) GetSettings(c *gin.Context) {
	settings, err := db.LoadUserSettings()
	if err != nil {
		log.Error().Err(err).Msg("failed to load settings")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load settings"})
		return
	}

	// Sanitize sensitive data before returning
	sanitized := db.SanitizeSettings(settings)
	c.JSON(http.StatusOK, sanitized)
}

// UpdateSettings handles PUT /api/settings
func (h *Handlers) UpdateSettings(c *gin.Context) {
	var updates models.UserSettings
	if err := c.ShouldBindJSON(&updates); err != nil {
		log.Error().Err(err).Msg("failed to parse settings update")
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	// Load current settings
	current, err := db.LoadUserSettings()
	if err != nil {
		log.Error().Err(err).Msg("failed to load current settings")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load current settings"})
		return
	}

	// Merge updates with current settings
	merged := mergeSettings(current, &updates)

	// Save merged settings
	if err := db.SaveUserSettings(merged); err != nil {
		log.Error().Err(err).Msg("failed to save settings")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save settings"})
		return
	}

	// Apply log level change immediately if it was updated
	if updates.Preferences.LogLevel != "" {
		log.SetLevel(merged.Preferences.LogLevel)
		log.Info().Str("level", merged.Preferences.LogLevel).Msg("log level updated")
	}

	// Return sanitized settings
	sanitized := db.SanitizeSettings(merged)
	c.JSON(http.StatusOK, sanitized)
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
	merged.Preferences.WeeklyDigest = updates.Preferences.WeeklyDigest
	merged.Preferences.DigestDay = updates.Preferences.DigestDay
	if updates.Preferences.LogLevel != "" {
		merged.Preferences.LogLevel = updates.Preferences.LogLevel
	}
	if updates.Preferences.UserEmail != "" {
		merged.Preferences.UserEmail = updates.Preferences.UserEmail
	}
	if len(updates.Preferences.Languages) > 0 {
		merged.Preferences.Languages = updates.Preferences.Languages
	}

	// Merge vendors
	if updates.Vendors != nil {
		if merged.Vendors == nil {
			merged.Vendors = &models.Vendors{}
		}

		if updates.Vendors.OpenAI != nil {
			if merged.Vendors.OpenAI == nil {
				merged.Vendors.OpenAI = &models.OpenAI{}
			}
			if updates.Vendors.OpenAI.BaseURL != "" {
				merged.Vendors.OpenAI.BaseURL = updates.Vendors.OpenAI.BaseURL
			}
			// Only update API key if it's not masked (not all asterisks)
			if updates.Vendors.OpenAI.APIKey != "" && !isMaskedAPIKey(updates.Vendors.OpenAI.APIKey) {
				merged.Vendors.OpenAI.APIKey = updates.Vendors.OpenAI.APIKey
			}
			if updates.Vendors.OpenAI.Model != "" {
				merged.Vendors.OpenAI.Model = updates.Vendors.OpenAI.Model
			}
		}

		if updates.Vendors.HomelabAI != nil {
			if merged.Vendors.HomelabAI == nil {
				merged.Vendors.HomelabAI = &models.HomelabAI{}
			}
			if updates.Vendors.HomelabAI.BaseURL != "" {
				merged.Vendors.HomelabAI.BaseURL = updates.Vendors.HomelabAI.BaseURL
			}
			if updates.Vendors.HomelabAI.ChromeCdpURL != "" {
				merged.Vendors.HomelabAI.ChromeCdpURL = updates.Vendors.HomelabAI.ChromeCdpURL
			}
		}

		if updates.Vendors.Aliyun != nil {
			if merged.Vendors.Aliyun == nil {
				merged.Vendors.Aliyun = &models.Aliyun{}
			}
			// Only update API keys if they're not masked (not all asterisks)
			if updates.Vendors.Aliyun.APIKey != "" && !isMaskedAPIKey(updates.Vendors.Aliyun.APIKey) {
				merged.Vendors.Aliyun.APIKey = updates.Vendors.Aliyun.APIKey
			}
			if updates.Vendors.Aliyun.Region != "" {
				merged.Vendors.Aliyun.Region = updates.Vendors.Aliyun.Region
			}
			if updates.Vendors.Aliyun.ASRProvider != "" {
				merged.Vendors.Aliyun.ASRProvider = updates.Vendors.Aliyun.ASRProvider
			}
			if updates.Vendors.Aliyun.OSSAccessKeyID != "" && !isMaskedAPIKey(updates.Vendors.Aliyun.OSSAccessKeyID) {
				merged.Vendors.Aliyun.OSSAccessKeyID = updates.Vendors.Aliyun.OSSAccessKeyID
			}
			if updates.Vendors.Aliyun.OSSAccessKeySecret != "" && !isMaskedAPIKey(updates.Vendors.Aliyun.OSSAccessKeySecret) {
				merged.Vendors.Aliyun.OSSAccessKeySecret = updates.Vendors.Aliyun.OSSAccessKeySecret
			}
			if updates.Vendors.Aliyun.OSSRegion != "" {
				merged.Vendors.Aliyun.OSSRegion = updates.Vendors.Aliyun.OSSRegion
			}
			if updates.Vendors.Aliyun.OSSBucket != "" {
				merged.Vendors.Aliyun.OSSBucket = updates.Vendors.Aliyun.OSSBucket
			}
		}

		if updates.Vendors.Meilisearch != nil {
			if merged.Vendors.Meilisearch == nil {
				merged.Vendors.Meilisearch = &models.Meilisearch{}
			}
			if updates.Vendors.Meilisearch.Host != "" {
				merged.Vendors.Meilisearch.Host = updates.Vendors.Meilisearch.Host
			}
		}

		if updates.Vendors.Qdrant != nil {
			if merged.Vendors.Qdrant == nil {
				merged.Vendors.Qdrant = &models.Qdrant{}
			}
			if updates.Vendors.Qdrant.Host != "" {
				merged.Vendors.Qdrant.Host = updates.Vendors.Qdrant.Host
			}
		}
	}

	// Merge digesters
	if updates.Digesters != nil {
		if merged.Digesters == nil {
			merged.Digesters = make(map[string]bool)
		}
		for key, value := range updates.Digesters {
			merged.Digesters[key] = value
		}
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

// isMaskedAPIKey checks if a string is all asterisks (masked API key)
func isMaskedAPIKey(key string) bool {
	if key == "" {
		return false
	}
	for _, ch := range key {
		if ch != '*' {
			return false
		}
	}
	return true
}

// ResetSettings handles POST /api/settings
func (h *Handlers) ResetSettings(c *gin.Context) {
	// Parse request body to check for action
	var body map[string]string
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if body["action"] != "reset" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid action"})
		return
	}

	if err := db.ResetSettings(); err != nil {
		log.Error().Err(err).Msg("failed to reset settings")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset settings"})
		return
	}

	// Return default settings
	settings, err := db.LoadUserSettings()
	if err != nil {
		log.Error().Err(err).Msg("failed to load settings after reset")
		c.JSON(http.StatusOK, gin.H{"success": "true"})
		return
	}

	sanitized := db.SanitizeSettings(settings)
	c.JSON(http.StatusOK, sanitized)
}
