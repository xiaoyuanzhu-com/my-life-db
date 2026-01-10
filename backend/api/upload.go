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
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
	"github.com/xiaoyuanzhu-com/my-life-db/workers/fs"
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
		log.Info().Str("dir", uploadDir).Msg("TUS handler initialized")
	})
	return tusHandler, initErr
}

// TUSHandler handles all TUS protocol requests
func TUSHandler(c *gin.Context) {
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
func FinalizeUpload(c *gin.Context) {
	var body struct {
		Uploads []struct {
			UploadID string `json:"uploadId"`
			Filename string `json:"filename"`
			Size     int64  `json:"size"`
			Type     string `json:"type"`
		} `json:"uploads"`
		Text        string `json:"text,omitempty"`
		Destination string `json:"destination,omitempty"`
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

	// Default destination is inbox
	destination := body.Destination
	if destination == "" {
		destination = "inbox"
	}

	// Ensure destination directory exists
	destDir := filepath.Join(cfg.DataDir, destination)
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
		srcInfo, err := os.Stat(srcPath)
		if err != nil {
			// Fallback: check for file with .bin extension
			srcPath = srcPath + ".bin"
			srcInfo, err = os.Stat(srcPath)
			if err != nil {
				log.Error().Str("uploadId", upload.UploadID).Err(err).Msg("upload file not found")
				continue
			}
		}

		// Move file to destination
		destPath := filepath.Join(destination, filename)
		fullDestPath := filepath.Join(cfg.DataDir, destPath)

		// Try rename first (same filesystem)
		if err := os.Rename(srcPath, fullDestPath); err != nil {
			// Fallback to copy + delete
			if err := copyUploadFile(srcPath, fullDestPath); err != nil {
				log.Error().Err(err).Msg("failed to move upload file")
				continue
			}
			os.Remove(srcPath)
		}

		// Clean up TUS info file
		os.Remove(srcPath + ".info")

		// Create file record
		now := db.NowUTC()
		mimeType := upload.Type
		if mimeType == "" {
			mimeType = utils.DetectMimeType(filename)
		}
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

		log.Info().
			Str("path", destPath).
			Str("filename", filename).
			Int64("size", size).
			Str("mimeType", mimeType).
			Msg("upload finalized")

		paths = append(paths, destPath)
	}

	if len(paths) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No valid files to finalize"})
		return
	}

	// Process files for metadata (hash + text preview) in background
	fsWorker := fs.GetWorker()
	if fsWorker != nil {
		go func() {
			for _, path := range paths {
				fsWorker.ProcessFile(path)
			}
		}()
	}

	// Notify UI
	notifications.GetService().NotifyInboxChanged()

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
