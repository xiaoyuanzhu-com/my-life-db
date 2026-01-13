package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/vendors"
)

// GetOpenAIModels handles GET /api/vendors/openai/models
func (h *Handlers) GetOpenAIModels(c *gin.Context) {
	client := vendors.GetOpenAIClient()
	if client == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "OpenAI is not configured",
		})
		return
	}

	models, err := client.ListModels()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Failed to list models: " + err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, models)
}
