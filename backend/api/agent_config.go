package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetAgentConfig returns agent configuration for the frontend.
// This includes the server-managed model list (from AGENT_MODELS env var).
func (h *Handlers) GetAgentConfig(c *gin.Context) {
	cfg := h.server.Cfg()

	type modelInfo struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
	}

	var models []modelInfo
	for _, m := range cfg.AgentLLM.Models {
		models = append(models, modelInfo{
			ID:          m.ID,
			Name:        m.Name,
			Description: m.Description,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"models": models,
	})
}
