package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/vendors"
)

// GetOpenAIModels handles GET /api/vendors/openai/models
func GetOpenAIModels(c echo.Context) error {
	client := vendors.GetOpenAIClient()
	if client == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "OpenAI is not configured",
		})
	}

	models, err := client.ListModels()
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "Failed to list models: " + err.Error(),
		})
	}

	return c.JSON(http.StatusOK, models)
}
