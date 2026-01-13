package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// GetStats handles GET /api/stats
// Returns stats matching the Node.js implementation schema
func (h *Handlers) GetStats(c *gin.Context) {
	// Query library files (excluding app/ and inbox/)
	var libraryCount, librarySize int64
	err := db.GetDB().QueryRow(`
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

	// Query inbox items
	var inboxCount int64
	err = db.GetDB().QueryRow(`
		SELECT COUNT(*)
		FROM files
		WHERE is_folder = 0
		AND path LIKE 'inbox/%'
	`).Scan(&inboxCount)
	if err != nil {
		log.Error().Err(err).Msg("failed to get inbox stats")
		inboxCount = 0
	}

	// Query total files for digests
	var totalFiles int64
	err = db.GetDB().QueryRow(`
		SELECT COUNT(*)
		FROM files
		WHERE is_folder = 0
		AND path NOT LIKE 'app/%'
	`).Scan(&totalFiles)
	if err != nil {
		log.Error().Err(err).Msg("failed to get total files")
		totalFiles = 0
	}

	// Query digested files (completed status)
	var digestedFiles int64
	err = db.GetDB().QueryRow(`
		SELECT COUNT(DISTINCT file_path)
		FROM digests
		WHERE status = 'completed'
		AND file_path NOT LIKE 'app/%'
	`).Scan(&digestedFiles)
	if err != nil {
		log.Error().Err(err).Msg("failed to get digested files")
		digestedFiles = 0
	}

	// Query pending digests
	var pendingDigests int64
	err = db.GetDB().QueryRow(`
		SELECT COUNT(*)
		FROM digests
		WHERE status IN ('todo', 'in-progress')
		AND file_path NOT LIKE 'app/%'
	`).Scan(&pendingDigests)
	if err != nil {
		log.Error().Err(err).Msg("failed to get pending digests")
		pendingDigests = 0
	}

	// Return response matching Node.js schema exactly
	c.JSON(http.StatusOK, gin.H{
		"library": gin.H{
			"fileCount": libraryCount,
			"totalSize": librarySize,
		},
		"inbox": gin.H{
			"itemCount": inboxCount,
		},
		"digests": gin.H{
			"totalFiles":     totalFiles,
			"digestedFiles":  digestedFiles,
			"pendingDigests": pendingDigests,
		},
	})
}
