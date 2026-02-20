package api

import (
	"bytes"
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
	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

// uploadFileResult tracks per-file status in batch upload responses
type uploadFileResult struct {
	Path   string `json:"path"`
	Status string `json:"status"` // "created" or "skipped"
}

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
	var results []uploadFileResult
	for _, upload := range body.Uploads {
		if upload.UploadID == "" || upload.Filename == "" {
			log.Warn().
				Str("uploadId", upload.UploadID).
				Str("filename", upload.Filename).
				Msg("skipping upload with missing uploadId or filename")
			continue
		}

		// Sanitize filename
		filename := utils.SanitizeFilename(upload.Filename)

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

		// Compute hash of the incoming TUS file for duplicate detection
		incomingHash := computeFileHashFromPath(srcPath)

		// Content-aware deduplication: skip if identical file already exists
		dedup := utils.DeduplicateFileWithHash(destDir, filename, incomingHash, func(name string) string {
			relPath := filepath.Join(destination, name)
			rec, _ := db.GetFileByPath(relPath)
			if rec != nil && rec.Hash != nil {
				return *rec.Hash
			}
			return ""
		})

		destPath := filepath.Join(destination, dedup.Filename)

		if dedup.Action == utils.DedupActionSkip {
			// Exact duplicate — skip write, clean up TUS files
			os.Remove(srcPath)
			os.Remove(srcPath + ".info")

			log.Info().
				Str("path", destPath).
				Str("filename", filename).
				Msg("upload skipped: identical file already exists")

			paths = append(paths, destPath)
			results = append(results, uploadFileResult{Path: destPath, Status: string(utils.DedupActionSkip)})
			continue
		}

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
			Str("filename", dedup.Filename).
			Int64("size", *result.Record.Size).
			Str("mimeType", *result.Record.MimeType).
			Bool("isNew", result.IsNew).
			Bool("hashComputed", result.HashComputed).
			Msg("upload finalized")

		paths = append(paths, destPath)
		results = append(results, uploadFileResult{Path: destPath, Status: string(utils.DedupActionWrite)})
	}

	if len(paths) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No valid files to finalize"})
		return
	}

	// Notify UI (metadata processing happens automatically via fs.Service watcher)
	// Use inbox-changed for inbox uploads, library-changed for library uploads
	if body.Destination == nil || *body.Destination == "inbox" {
		h.server.Notifications().NotifyInboxChanged()
	} else {
		h.server.Notifications().NotifyLibraryChanged(paths[0], "upload")
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"path":    paths[0],
		"paths":   paths,
		"results": results,
	})
}

// SimpleUpload handles PUT /api/upload/simple/*path
// Single-request upload for small files, bypassing TUS protocol overhead.
// The URL path is the destination path (directory + filename).
// Request body is the raw file content, Content-Type header is the MIME type.
func (h *Handlers) SimpleUpload(c *gin.Context) {
	// Extract path from URL param (Gin wildcard includes leading slash)
	rawPath := strings.TrimPrefix(c.Param("path"), "/")
	if rawPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}

	// Split into directory and filename
	dir := filepath.Dir(rawPath)
	filename := filepath.Base(rawPath)
	if filename == "" || filename == "." {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Filename is required in path"})
		return
	}

	// Sanitize filename
	filename = utils.SanitizeFilename(filename)

	// Ensure destination directory exists
	cfg := config.Get()
	destDir := filepath.Join(cfg.UserDataDir, dir)
	if err := os.MkdirAll(destDir, 0755); err != nil {
		log.Error().Err(err).Str("dir", destDir).Msg("simple upload: failed to create destination directory")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create destination directory"})
		return
	}

	// Buffer the request body so we can compute hash before deciding whether to write.
	// Simple uploads are small files (typically ≤1MB), so buffering in memory is fine.
	defer c.Request.Body.Close()
	bodyBytes, err := io.ReadAll(c.Request.Body)
	if err != nil {
		log.Error().Err(err).Msg("simple upload: failed to read request body")
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to read request body"})
		return
	}

	// Compute hash of the incoming content for duplicate detection
	incomingHash, _ := utils.ComputeFileHash(bytes.NewReader(bodyBytes))

	// Content-aware deduplication: skip if identical file already exists
	dedup := utils.DeduplicateFileWithHash(destDir, filename, incomingHash, func(name string) string {
		relPath := filepath.Join(dir, name)
		rec, _ := db.GetFileByPath(relPath)
		if rec != nil && rec.Hash != nil {
			return *rec.Hash
		}
		return ""
	})

	destPath := filepath.Join(dir, dedup.Filename)
	status := string(dedup.Action)

	if dedup.Action == utils.DedupActionSkip {
		log.Info().
			Str("path", destPath).
			Str("filename", filename).
			Msg("simple upload skipped: identical file already exists")
	} else {
		// Write via fs.Service.WriteFile()
		result, err := h.server.FS().WriteFile(c.Request.Context(), fs.WriteRequest{
			Path:            destPath,
			Content:         bytes.NewReader(bodyBytes),
			MimeType:        c.ContentType(),
			Source:          "upload",
			ComputeMetadata: true,
			Sync:            true,
		})
		if err != nil {
			log.Error().Err(err).Str("path", destPath).Msg("simple upload: failed to write file")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write file"})
			return
		}

		log.Info().
			Str("path", destPath).
			Str("filename", dedup.Filename).
			Int64("size", *result.Record.Size).
			Str("mimeType", *result.Record.MimeType).
			Bool("isNew", result.IsNew).
			Bool("hashComputed", result.HashComputed).
			Msg("simple upload completed")
	}

	// Notify UI
	if dir == "inbox" || dir == "" || dir == "." {
		h.server.Notifications().NotifyInboxChanged()
	} else {
		h.server.Notifications().NotifyLibraryChanged(destPath, "upload")
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"path":    destPath,
		"paths":   []string{destPath},
		"results": []uploadFileResult{{Path: destPath, Status: status}},
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

// computeFileHashFromPath computes SHA-256 hash of a file on disk.
// Returns empty string on error (best-effort; dedup falls back to rename).
func computeFileHashFromPath(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	hash, err := utils.ComputeFileHash(f)
	if err != nil {
		return ""
	}
	return hash
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
