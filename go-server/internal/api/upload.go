package api

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/labstack/echo/v4"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/config"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/db"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/log"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/notifications"
)

var uploadLogger = log.GetLogger("ApiUpload")

// TUS upload handling
// For full TUS protocol support, we'll integrate with tusd library

// TUSHandler handles all TUS protocol requests
func TUSHandler(c echo.Context) error {
	// This is a placeholder for TUS protocol handling
	// In a complete implementation, we would use github.com/tus/tusd/v2
	//
	// For now, fall back to simple upload handling

	switch c.Request().Method {
	case http.MethodOptions:
		// TUS OPTIONS request - return supported extensions
		c.Response().Header().Set("Tus-Resumable", "1.0.0")
		c.Response().Header().Set("Tus-Version", "1.0.0")
		c.Response().Header().Set("Tus-Extension", "creation,creation-with-upload,termination")
		c.Response().Header().Set("Tus-Max-Size", "10737418240") // 10GB
		return c.NoContent(http.StatusNoContent)

	case http.MethodPost:
		// TUS creation request
		return handleTUSCreate(c)

	case http.MethodPatch:
		// TUS upload chunk
		return handleTUSPatch(c)

	case http.MethodHead:
		// TUS status check
		return handleTUSHead(c)

	case http.MethodDelete:
		// TUS termination
		return handleTUSDelete(c)

	default:
		return c.JSON(http.StatusMethodNotAllowed, map[string]string{
			"error": "Method not allowed",
		})
	}
}

func handleTUSCreate(c echo.Context) error {
	// In a full implementation, this would:
	// 1. Parse Upload-Metadata header
	// 2. Create a temporary file
	// 3. Return the upload URL

	uploadLength := c.Request().Header.Get("Upload-Length")
	uploadMetadata := c.Request().Header.Get("Upload-Metadata")

	uploadLogger.Info().
		Str("length", uploadLength).
		Str("metadata", uploadMetadata).
		Msg("TUS create request")

	// Generate upload ID
	uploadID := db.NowUTC() // Simple ID based on timestamp

	// Return upload location
	c.Response().Header().Set("Tus-Resumable", "1.0.0")
	c.Response().Header().Set("Location", "/api/upload/tus/"+uploadID)

	return c.NoContent(http.StatusCreated)
}

func handleTUSPatch(c echo.Context) error {
	// In a full implementation, this would:
	// 1. Append data to the temporary file
	// 2. Update Upload-Offset

	uploadOffset := c.Request().Header.Get("Upload-Offset")

	uploadLogger.Debug().
		Str("offset", uploadOffset).
		Msg("TUS patch request")

	c.Response().Header().Set("Tus-Resumable", "1.0.0")
	c.Response().Header().Set("Upload-Offset", uploadOffset)

	return c.NoContent(http.StatusNoContent)
}

func handleTUSHead(c echo.Context) error {
	// Return current upload status
	c.Response().Header().Set("Tus-Resumable", "1.0.0")
	c.Response().Header().Set("Upload-Offset", "0")
	c.Response().Header().Set("Upload-Length", "0")

	return c.NoContent(http.StatusOK)
}

func handleTUSDelete(c echo.Context) error {
	// Delete the upload
	return c.NoContent(http.StatusNoContent)
}

// FinalizeUpload handles POST /api/upload/finalize
func FinalizeUpload(c echo.Context) error {
	var body struct {
		UploadID    string `json:"uploadId"`
		Filename    string `json:"filename"`
		Destination string `json:"destination"`
	}
	if err := c.Bind(&body); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
	}

	if body.UploadID == "" || body.Filename == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Upload ID and filename are required"})
	}

	cfg := config.Get()

	// Default destination is inbox
	destination := body.Destination
	if destination == "" {
		destination = "inbox"
	}

	// Ensure destination directory exists
	destDir := filepath.Join(cfg.DataDir, destination)
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to create destination directory"})
	}

	// Get unique filename
	filename := sanitizeFilename(body.Filename)
	filename = deduplicateFilename(destDir, filename)

	// In a full implementation, this would move the TUS upload file to the destination
	destPath := filepath.Join(destination, filename)
	fullPath := filepath.Join(cfg.DataDir, destPath)

	// Create empty file as placeholder
	if err := os.WriteFile(fullPath, []byte{}, 0644); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to finalize upload"})
	}

	// Create file record
	now := db.NowUTC()
	mimeType := detectMimeType(filename)
	size := int64(0)

	db.UpsertFile(&db.FileRecord{
		Path:          destPath,
		Name:          filename,
		IsFolder:      false,
		Size:          &size,
		MimeType:      &mimeType,
		ModifiedAt:    now,
		CreatedAt:     now,
		LastScannedAt: now,
	})

	uploadLogger.Info().
		Str("path", destPath).
		Str("filename", filename).
		Msg("upload finalized")

	// Notify UI
	notifications.GetService().NotifyInboxChanged()

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success": true,
		"path":    destPath,
	})
}
