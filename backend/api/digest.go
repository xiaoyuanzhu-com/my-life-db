package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Available digesters
var availableDigesters = []map[string]string{
	{"name": "tags", "description": "Generate tags using AI"},
	{"name": "url-crawler", "description": "Crawl and extract content from URLs"},
	{"name": "url-crawl-summary", "description": "Summarize crawled URL content"},
	{"name": "doc-to-markdown", "description": "Convert documents to markdown"},
	{"name": "doc-to-screenshot", "description": "Generate document screenshots"},
	{"name": "image-captioning", "description": "Generate image captions"},
	{"name": "image-ocr", "description": "Extract text from images"},
	{"name": "image-objects", "description": "Detect objects in images"},
	{"name": "speech-recognition", "description": "Transcribe audio/video"},
	{"name": "speech-recognition-cleanup", "description": "Clean up transcripts"},
	{"name": "speech-recognition-summary", "description": "Summarize transcripts"},
	{"name": "speaker-embedding", "description": "Extract speaker voice embeddings"},
	{"name": "search-keyword", "description": "Index for keyword search"},
	{"name": "search-semantic", "description": "Index for semantic search"},
}

// GetDigesters handles GET /api/digest/digesters
func GetDigesters(c *gin.Context) {
	c.JSON(http.StatusOK, availableDigesters)
}

// GetDigestStats handles GET /api/digest/stats
func GetDigestStats(c *gin.Context) {
	stats, err := db.GetDigestStats()
	if err != nil {
		log.Error().Err(err).Msg("failed to get digest stats")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get digest stats"})
		return
	}

	c.JSON(http.StatusOK, stats)
}

// ResetDigester handles POST /api/digest/reset/:digester
func ResetDigester(c *gin.Context) {
	digester := c.Param("digester")
	if digester == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Digester name is required"})
		return
	}

	affected, err := db.ResetDigesterAll(digester)
	if err != nil {
		log.Error().Err(err).Str("digester", digester).Msg("failed to reset digester")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset digester"})
		return
	}

	log.Info().Str("digester", digester).Int64("affected", affected).Msg("reset digester")

	c.JSON(http.StatusOK, gin.H{
		"success":  true,
		"affected": affected,
	})
}

// GetDigest handles GET /api/digest/*path
func GetDigest(c *gin.Context) {
	path := c.Param("path")
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}

	digests, err := db.GetDigestsForFile(path)
	if err != nil {
		log.Error().Err(err).Str("path", path).Msg("failed to get digests")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get digests"})
		return
	}

	// Build status summary
	status := "done"
	for _, d := range digests {
		if d.Status == "running" {
			status = "processing"
			break
		}
		if d.Status == "todo" || d.Status == "failed" {
			status = "pending"
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"path":    path,
		"status":  status,
		"digests": digests,
	})
}

// TriggerDigest handles POST /api/digest/*path
func TriggerDigest(c *gin.Context) {
	path := c.Param("path")
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}

	// Check if file exists
	file, err := db.GetFileByPath(path)
	if err != nil || file == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	// Parse optional digester from body
	var body struct {
		Digester string `json:"digester"`
		Force    bool   `json:"force"`
	}
	c.ShouldBindJSON(&body)

	if body.Digester != "" {
		// Reset specific digester
		digest, err := db.GetDigestByFileAndDigester(path, body.Digester)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get digest"})
			return
		}

		if digest == nil {
			// Create new digest record
			digest = &db.Digest{
				FilePath:  path,
				Digester:  body.Digester,
				Status:    db.DigestStatusTodo,
				CreatedAt: db.NowUTC(),
				UpdatedAt: db.NowUTC(),
			}
			if err := db.CreateDigest(digest); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create digest"})
				return
			}
		} else if body.Force {
			// Reset existing digest
			digest.Status = db.DigestStatusTodo
			digest.Error = nil
			digest.Attempts = 0
			if err := db.UpdateDigest(digest); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset digest"})
				return
			}
		}
	} else {
		// Reset all digests for this file
		if err := db.DeleteDigestsForFile(path); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset digests"})
			return
		}
	}

	// TODO: Trigger digest processing in worker

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Digest processing triggered",
		"path":    path,
	})
}
