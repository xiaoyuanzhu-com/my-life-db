package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/db"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/log"
)

var digestLogger = log.GetLogger("ApiDigest")

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
func GetDigesters(c echo.Context) error {
	return c.JSON(http.StatusOK, availableDigesters)
}

// GetDigestStats handles GET /api/digest/stats
func GetDigestStats(c echo.Context) error {
	stats, err := db.GetDigestStats()
	if err != nil {
		digestLogger.Error().Err(err).Msg("failed to get digest stats")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to get digest stats"})
	}

	return c.JSON(http.StatusOK, stats)
}

// ResetDigester handles POST /api/digest/reset/:digester
func ResetDigester(c echo.Context) error {
	digester := c.Param("digester")
	if digester == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Digester name is required"})
	}

	affected, err := db.ResetDigesterAll(digester)
	if err != nil {
		digestLogger.Error().Err(err).Str("digester", digester).Msg("failed to reset digester")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to reset digester"})
	}

	digestLogger.Info().Str("digester", digester).Int64("affected", affected).Msg("reset digester")

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success":  true,
		"affected": affected,
	})
}

// GetDigest handles GET /api/digest/*
func GetDigest(c echo.Context) error {
	path := c.Param("*")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Path is required"})
	}

	digests, err := db.GetDigestsForFile(path)
	if err != nil {
		digestLogger.Error().Err(err).Str("path", path).Msg("failed to get digests")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to get digests"})
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

	return c.JSON(http.StatusOK, map[string]interface{}{
		"path":    path,
		"status":  status,
		"digests": digests,
	})
}

// TriggerDigest handles POST /api/digest/*
func TriggerDigest(c echo.Context) error {
	path := c.Param("*")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Path is required"})
	}

	// Check if file exists
	file, err := db.GetFileByPath(path)
	if err != nil || file == nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "File not found"})
	}

	// Parse optional digester from body
	var body struct {
		Digester string `json:"digester"`
		Force    bool   `json:"force"`
	}
	c.Bind(&body)

	if body.Digester != "" {
		// Reset specific digester
		digest, err := db.GetDigestByFileAndDigester(path, body.Digester)
		if err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to get digest"})
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
				return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to create digest"})
			}
		} else if body.Force {
			// Reset existing digest
			digest.Status = db.DigestStatusTodo
			digest.Error = nil
			digest.Attempts = 0
			if err := db.UpdateDigest(digest); err != nil {
				return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to reset digest"})
			}
		}
	} else {
		// Reset all digests for this file
		if err := db.DeleteDigestsForFile(path); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to reset digests"})
		}
	}

	// TODO: Trigger digest processing in worker

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "Digest processing triggered",
		"path":    path,
	})
}
