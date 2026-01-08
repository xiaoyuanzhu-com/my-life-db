package api

import (
	"encoding/base64"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/labstack/echo/v4"
	"github.com/tus/tusd/v2/pkg/filestore"
	tusd "github.com/tus/tusd/v2/pkg/handler"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/config"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/db"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/log"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/notifications"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/utils"
)

var uploadLogger = log.GetLogger("ApiUpload")

var (
	tusHandler     http.Handler
	tusHandlerOnce sync.Once
	uploadDir      string
)

// InitTUSHandler initializes the TUS upload handler
func InitTUSHandler() (http.Handler, error) {
	var initErr error
	tusHandlerOnce.Do(func() {
		cfg := config.Get()
		uploadDir = filepath.Join(cfg.DataDir, "app", "my-life-db", "uploads")

		// Ensure upload directory exists
		if err := os.MkdirAll(uploadDir, 0755); err != nil {
			initErr = err
			return
		}

		// Create file store
		store := filestore.New(uploadDir)

		// Create TUS handler
		composer := tusd.NewStoreComposer()
		store.UseIn(composer)

		handler, err := tusd.NewHandler(tusd.Config{
			BasePath:                "/api/upload/tus/",
			StoreComposer:           composer,
			RespectForwardedHeaders: true,
			MaxSize:                 10 * 1024 * 1024 * 1024, // 10GB
		})
		if err != nil {
			initErr = err
			return
		}

		tusHandler = handler
		uploadLogger.Info().Str("dir", uploadDir).Msg("TUS handler initialized")
	})
	return tusHandler, initErr
}

// TUSHandler handles all TUS protocol requests
func TUSHandler(c echo.Context) error {
	handler, err := InitTUSHandler()
	if err != nil {
		uploadLogger.Error().Err(err).Msg("failed to initialize TUS handler")
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "Failed to initialize upload handler",
		})
	}

	// Strip the /api/upload/tus prefix and pass to handler
	handler.ServeHTTP(c.Response().Writer, c.Request())
	return nil
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

	// Get unique filename using utils helpers
	filename := utils.SanitizeFilename(body.Filename)
	filename = utils.DeduplicateFilename(destDir, filename)

	// Source file from TUS uploads
	srcPath := filepath.Join(uploadDir, body.UploadID)

	// Check if TUS upload file exists
	srcInfo, err := os.Stat(srcPath)
	if err != nil {
		// Fallback: check for file with .bin extension
		srcPath = srcPath + ".bin"
		srcInfo, err = os.Stat(srcPath)
		if err != nil {
			uploadLogger.Error().Str("uploadId", body.UploadID).Err(err).Msg("upload file not found")
			return c.JSON(http.StatusNotFound, map[string]string{"error": "Upload file not found"})
		}
	}

	// Move file to destination
	destPath := filepath.Join(destination, filename)
	fullDestPath := filepath.Join(cfg.DataDir, destPath)

	// Try rename first (same filesystem)
	if err := os.Rename(srcPath, fullDestPath); err != nil {
		// Fallback to copy + delete
		if err := copyUploadFile(srcPath, fullDestPath); err != nil {
			uploadLogger.Error().Err(err).Msg("failed to move upload file")
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to finalize upload"})
		}
		os.Remove(srcPath)
	}

	// Clean up TUS info file
	os.Remove(srcPath + ".info")

	// Create file record
	now := db.NowUTC()
	mimeType := utils.DetectMimeType(filename)
	size := srcInfo.Size()

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
		Int64("size", size).
		Msg("upload finalized")

	// Notify UI
	notifications.GetService().NotifyInboxChanged()

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success": true,
		"path":    destPath,
	})
}

// Helper functions specific to upload

func copyUploadFile(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	_, err = io.Copy(dstFile, srcFile)
	return err
}

// parseMetadata parses the Upload-Metadata header
func parseMetadata(header string) map[string]string {
	metadata := make(map[string]string)
	if header == "" {
		return metadata
	}

	pairs := strings.Split(header, ",")
	for _, pair := range pairs {
		pair = strings.TrimSpace(pair)
		parts := strings.SplitN(pair, " ", 2)
		if len(parts) == 2 {
			key := parts[0]
			value, err := base64.StdEncoding.DecodeString(parts[1])
			if err == nil {
				metadata[key] = string(value)
			}
		} else if len(parts) == 1 {
			metadata[parts[0]] = ""
		}
	}
	return metadata
}
