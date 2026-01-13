package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// DigesterInfo represents digester metadata for the API
type DigesterInfo struct {
	Name        string   `json:"name"`
	Label       string   `json:"label"`
	Description string   `json:"description"`
	Outputs     []string `json:"outputs"`
}

// Available digesters with proper schema matching Node.js
var availableDigesters = []DigesterInfo{
	{Name: "tags", Label: "Tags", Description: "Generate tags using AI", Outputs: []string{"tags"}},
	{Name: "url-crawler", Label: "URL Crawler", Description: "Crawl and extract content from URLs", Outputs: []string{"url-crawler"}},
	{Name: "url-crawl-summary", Label: "URL Summary", Description: "Summarize crawled URL content", Outputs: []string{"url-crawl-summary"}},
	{Name: "doc-to-markdown", Label: "Doc to Markdown", Description: "Convert documents to markdown", Outputs: []string{"doc-to-markdown"}},
	{Name: "doc-to-screenshot", Label: "Doc Screenshot", Description: "Generate document screenshots", Outputs: []string{"doc-to-screenshot"}},
	{Name: "image-captioning", Label: "Image Captioning", Description: "Generate image captions", Outputs: []string{"image-captioning"}},
	{Name: "image-ocr", Label: "Image OCR", Description: "Extract text from images", Outputs: []string{"image-ocr"}},
	{Name: "image-objects", Label: "Image Objects", Description: "Detect objects in images", Outputs: []string{"image-objects"}},
	{Name: "speech-recognition", Label: "Speech Recognition", Description: "Transcribe audio/video", Outputs: []string{"speech-recognition"}},
	{Name: "speech-recognition-cleanup", Label: "Transcript Cleanup", Description: "Clean up transcripts", Outputs: []string{"speech-recognition-cleanup"}},
	{Name: "speech-recognition-summary", Label: "Speech Recognition Summary", Description: "Summarize transcripts", Outputs: []string{"speech-recognition-summary"}},
	{Name: "speaker-embedding", Label: "Speaker ID", Description: "Extract and cluster speaker voice embeddings for identification", Outputs: []string{"speaker-embedding"}},
	{Name: "search-keyword", Label: "Keyword Search", Description: "Index for keyword search", Outputs: []string{"search-keyword"}},
	{Name: "search-semantic", Label: "Semantic Search", Description: "Index for semantic search", Outputs: []string{"search-semantic"}},
}

// GetDigesters handles GET /api/digest/digesters
// Returns digester info matching Node.js schema with wrapper object
func (h *Handlers) GetDigesters(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"digesters": availableDigesters,
	})
}

// GetDigestStats handles GET /api/digest/stats
func (h *Handlers) GetDigestStats(c *gin.Context) {
	stats, err := db.GetDigestStats()
	if err != nil {
		log.Error().Err(err).Msg("failed to get digest stats")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get digest stats"})
		return
	}

	c.JSON(http.StatusOK, stats)
}

// ResetDigester handles DELETE /api/digest/reset/:digester
func (h *Handlers) ResetDigester(c *gin.Context) {
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
func (h *Handlers) GetDigest(c *gin.Context) {
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
func (h *Handlers) TriggerDigest(c *gin.Context) {
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

	// Parse optional digester from body or query param
	var body struct {
		Digester string `json:"digester"`
		Force    bool   `json:"force"`
	}
	c.ShouldBindJSON(&body)

	// Check query param if not in body
	digester := body.Digester
	if digester == "" {
		digester = c.Query("digester")
	}

	// Force defaults to true when digester is specified (for rerun behavior)
	force := body.Force
	if digester != "" && !force {
		force = true
	}

	if digester != "" {
		// Reset specific digester
		digest, err := db.GetDigestByFileAndDigester(path, digester)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get digest"})
			return
		}

		if digest == nil {
			// Create new digest record
			digest = &db.Digest{
				FilePath:  path,
				Digester:  digester,
				Status:    db.DigestStatusTodo,
				CreatedAt: db.NowUTC(),
				UpdatedAt: db.NowUTC(),
			}
			if err := db.CreateDigest(digest); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create digest"})
				return
			}
		} else if force {
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

	// Ensure digest placeholders exist for all digesters (like Node.js ensureAllDigesters)
	added, orphaned := h.server.Digest().EnsureDigestersForFile(path)
	log.Info().
		Str("path", path).
		Str("digester", digester).
		Int("added", added).
		Int("orphaned", orphaned).
		Msg("ensuring digesters and queuing file")
	// Queue file for processing
	h.server.Digest().RequestDigest(path)

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Digest processing triggered",
		"path":    path,
	})
}
