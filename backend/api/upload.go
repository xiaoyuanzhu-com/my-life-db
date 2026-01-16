package api

import (
	"encoding/base64"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/tus/tusd/v2/pkg/filestore"
	tusd "github.com/tus/tusd/v2/pkg/handler"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

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
		uploadDir = filepath.Join(cfg.AppDataDir, "uploads")

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
		log.Info().Str("dir", uploadDir).Msg("TUS handler initialized")
	})
	return tusHandler, initErr
}

// TUSHandler handles all TUS protocol requests
func (h *Handlers) TUSHandler(c *gin.Context) {
	handler, err := InitTUSHandler()
	if err != nil {
		log.Error().Err(err).Msg("failed to initialize TUS handler")
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Failed to initialize upload handler",
		})
		return
	}

	// Log the incoming request details for debugging
	log.Debug().
		Str("host", c.Request.Host).
		Str("method", c.Request.Method).
		Str("path", c.Request.URL.Path).
		Msg("TUS request received")

	// Manually strip the /api/upload/tus prefix from the request URL
	// TUS handler expects paths without the base path prefix
	// We need to manually strip because http.StripPrefix doesn't work well with Gin's wildcard routes
	originalPath := c.Request.URL.Path
	strippedPath := strings.TrimPrefix(originalPath, "/api/upload/tus")
	c.Request.URL.Path = strippedPath

	handler.ServeHTTP(c.Writer, c.Request)

	// Restore original path (good practice)
	c.Request.URL.Path = originalPath
}

// FinalizeUpload handles POST /api/upload/finalize
// Accepts array of uploads to support batch finalization (matching Node.js API)
func (h *Handlers) FinalizeUpload(c *gin.Context) {
	var body struct {
		Uploads []struct {
			UploadID string `json:"uploadId"`
			Filename string `json:"filename"`
			Size     int64  `json:"size"`
			Type     string `json:"type"`
		} `json:"uploads"`
		Text        string  `json:"text,omitempty"`
		Destination *string `json:"destination,omitempty"` // Pointer to distinguish nil (not provided) vs "" (empty string)
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if len(body.Uploads) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No uploads provided"})
		return
	}

	cfg := config.Get()

	// Determine destination:
	// - If Destination field is not provided (nil): use "inbox" (default)
	// - If Destination is empty string (""): use data root (empty path)
	// - Otherwise: use the provided destination path
	var destination string
	if body.Destination == nil {
		destination = "inbox"
	} else {
		destination = *body.Destination
	}

	// Ensure destination directory exists
	destDir := filepath.Join(cfg.UserDataDir, destination)
	if err := os.MkdirAll(destDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create destination directory"})
		return
	}

	// Process each upload
	var paths []string
	for _, upload := range body.Uploads {
		if upload.UploadID == "" || upload.Filename == "" {
			log.Warn().
				Str("uploadId", upload.UploadID).
				Str("filename", upload.Filename).
				Msg("skipping upload with missing uploadId or filename")
			continue
		}

		// Get unique filename using utils helpers
		filename := utils.SanitizeFilename(upload.Filename)
		filename = utils.DeduplicateFilename(destDir, filename)

		// Source file from TUS uploads
		srcPath := filepath.Join(uploadDir, upload.UploadID)

		// Check if TUS upload file exists
		_, err := os.Stat(srcPath)
		if err != nil {
			// Fallback: check for file with .bin extension
			srcPath = srcPath + ".bin"
			_, err = os.Stat(srcPath)
			if err != nil {
				log.Error().Str("uploadId", upload.UploadID).Err(err).Msg("upload file not found")
				continue
			}
		}

		// Destination path for the file
		destPath := filepath.Join(destination, filename)

		// Open uploaded file for reading
		uploadedFile, err := os.Open(srcPath)
		if err != nil {
			log.Error().Err(err).Str("uploadId", upload.UploadID).Msg("failed to open uploaded file")
			continue
		}

		// Use fs.Service.WriteFile() - single entry point for all file operations
		// This handles: file write, metadata computation, DB upsert, digest notification
		result, err := h.server.FS().WriteFile(c.Request.Context(), fs.WriteRequest{
			Path:            destPath,
			Content:         uploadedFile,
			MimeType:        upload.Type, // Pass through user-provided MIME type
			Source:          "upload",
			ComputeMetadata: true,
			Sync:            true, // Compute metadata synchronously for immediate availability
		})
		uploadedFile.Close()

		if err != nil {
			log.Error().Err(err).Str("path", destPath).Msg("failed to write uploaded file")
			continue
		}

		// Clean up TUS upload files
		os.Remove(srcPath)
		os.Remove(srcPath + ".info")

		log.Info().
			Str("path", destPath).
			Str("filename", filename).
			Int64("size", *result.Record.Size).
			Str("mimeType", *result.Record.MimeType).
			Bool("isNew", result.IsNew).
			Bool("hashComputed", result.HashComputed).
			Msg("upload finalized")

		paths = append(paths, destPath)
	}

	if len(paths) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No valid files to finalize"})
		return
	}

	// Notify UI (metadata processing happens automatically via fs.Service watcher)
	h.server.Notifications().NotifyInboxChanged()

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"path":    paths[0],
		"paths":   paths,
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
