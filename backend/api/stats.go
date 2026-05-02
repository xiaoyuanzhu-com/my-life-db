package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// GetStats handles GET /api/stats
// Returns stats matching the Node.js implementation schema
func (h *Handlers) GetStats(c *gin.Context) {
	// Query library files (excluding app/ and inbox/)
	var libraryCount, librarySize int64
	err := h.server.IndexDB().Read().QueryRow(`
		SELECT COUNT(*), COALESCE(SUM(size), 0)
		FROM files
		WHERE is_folder = 0
		AND path NOT LIKE 'app/%'
		AND path NOT LIKE 'inbox/%'
	`).Scan(&libraryCount, &librarySize)
	if err != nil {
		log.Error().Err(err).Msg("failed to get library stats")
		libraryCount, librarySize = 0, 0
	}

	c.JSON(http.StatusOK, gin.H{
		"library": gin.H{
			"fileCount": libraryCount,
			"totalSize": librarySize,
		},
	})
}
