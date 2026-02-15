package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/models"
)

func (h *Handlers) GetCollectors(c *gin.Context) {
	collectors, err := db.GetCollectors()
	if err != nil {
		log.Error().Err(err).Msg("failed to load collectors")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load collectors"})
		return
	}
	if collectors == nil {
		collectors = []models.CollectorConfig{}
	}
	c.JSON(http.StatusOK, collectors)
}

func (h *Handlers) UpsertCollector(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Collector ID is required"})
		return
	}

	var req models.UpdateCollectorRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if req.Enabled == nil && req.Config == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Nothing to update"})
		return
	}

	result, err := db.UpsertCollector(id, &req)
	if err != nil {
		log.Error().Err(err).Str("id", id).Msg("failed to upsert collector")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update collector"})
		return
	}

	c.JSON(http.StatusOK, result)
}
