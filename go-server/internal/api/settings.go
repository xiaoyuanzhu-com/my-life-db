package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/db"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/log"
)

var settingsLogger = log.GetLogger("ApiSettings")

// GetSettings handles GET /api/settings
func GetSettings(c echo.Context) error {
	settings, err := db.GetAllSettings()
	if err != nil {
		settingsLogger.Error().Err(err).Msg("failed to get settings")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to get settings"})
	}

	return c.JSON(http.StatusOK, settings)
}

// UpdateSettings handles PUT /api/settings
func UpdateSettings(c echo.Context) error {
	var updates map[string]string
	if err := c.Bind(&updates); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
	}

	if err := db.UpdateSettings(updates); err != nil {
		settingsLogger.Error().Err(err).Msg("failed to update settings")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to update settings"})
	}

	// Return updated settings
	settings, err := db.GetAllSettings()
	if err != nil {
		return c.JSON(http.StatusOK, map[string]string{"success": "true"})
	}

	return c.JSON(http.StatusOK, settings)
}

// ResetSettings handles POST /api/settings
func ResetSettings(c echo.Context) error {
	if err := db.ResetSettings(); err != nil {
		settingsLogger.Error().Err(err).Msg("failed to reset settings")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to reset settings"})
	}

	// Return default settings
	settings, err := db.GetAllSettings()
	if err != nil {
		return c.JSON(http.StatusOK, map[string]string{"success": "true"})
	}

	return c.JSON(http.StatusOK, settings)
}
