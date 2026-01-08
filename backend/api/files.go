package api

import (
	"compress/flate"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

var filesLogger = log.GetLogger("ApiFiles")

// ServeRawFile handles GET /raw/*
func ServeRawFile(c echo.Context) error {
	// Get path from URL (everything after /raw/)
	path := c.Param("*")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Path is required"})
	}

	// Security: prevent directory traversal
	if strings.Contains(path, "..") {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid path"})
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, path)

	// Check if file exists
	info, err := os.Stat(fullPath)
	if os.IsNotExist(err) {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "File not found"})
	}
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to access file"})
	}

	if info.IsDir() {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Cannot serve directory"})
	}

	// Detect MIME type
	mimeType := utils.DetectMimeType(path)

	// Set headers
	c.Response().Header().Set("Content-Type", mimeType)
	c.Response().Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))

	// Handle range requests for media files
	if strings.HasPrefix(mimeType, "video/") || strings.HasPrefix(mimeType, "audio/") {
		return c.File(fullPath)
	}

	return c.File(fullPath)
}

// SaveRawFile handles PUT /raw/*
func SaveRawFile(c echo.Context) error {
	path := c.Param("*")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Path is required"})
	}

	// Security: prevent directory traversal
	if strings.Contains(path, "..") {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid path"})
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, path)

	// Ensure parent directory exists
	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		filesLogger.Error().Err(err).Msg("failed to create directory")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to create directory"})
	}

	// Read request body
	body, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Failed to read request body"})
	}

	// Write file
	if err := os.WriteFile(fullPath, body, 0644); err != nil {
		filesLogger.Error().Err(err).Msg("failed to write file")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to write file"})
	}

	// Update database
	info, _ := os.Stat(fullPath)
	size := info.Size()
	mimeType := utils.DetectMimeType(path)
	now := db.NowUTC()

	db.UpsertFile(&db.FileRecord{
		Path:          path,
		Name:          filepath.Base(path),
		IsFolder:      false,
		Size:          &size,
		MimeType:      &mimeType,
		ModifiedAt:    now,
		CreatedAt:     now,
		LastScannedAt: now,
	})

	return c.JSON(http.StatusOK, map[string]string{"success": "true"})
}

// ServeSqlarFile handles GET /sqlar/*
func ServeSqlarFile(c echo.Context) error {
	name := c.Param("*")
	if name == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Name is required"})
	}

	// Query sqlar table
	var sqlarFile db.SqlarFile
	err := db.GetDB().QueryRow(`
		SELECT name, mode, mtime, sz, data FROM sqlar WHERE name = ?
	`, name).Scan(&sqlarFile.Name, &sqlarFile.Mode, &sqlarFile.Mtime, &sqlarFile.Size, &sqlarFile.Data)

	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "File not found in archive"})
	}

	// Decompress if needed (sqlar uses zlib compression)
	var data []byte
	if sqlarFile.Size > 0 && len(sqlarFile.Data) < sqlarFile.Size {
		// Data is compressed
		reader := flate.NewReader(strings.NewReader(string(sqlarFile.Data)))
		defer reader.Close()
		data, err = io.ReadAll(reader)
		if err != nil {
			// Try uncompressed
			data = sqlarFile.Data
		}
	} else {
		data = sqlarFile.Data
	}

	// Detect MIME type
	mimeType := utils.DetectMimeType(name)

	c.Response().Header().Set("Content-Type", mimeType)
	c.Response().Header().Set("Content-Length", strconv.Itoa(len(data)))

	return c.Blob(http.StatusOK, mimeType, data)
}

// DeleteLibraryFile handles DELETE /api/library/file
func DeleteLibraryFile(c echo.Context) error {
	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Path is required"})
	}

	// Security: prevent directory traversal
	if strings.Contains(path, "..") {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid path"})
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, path)

	// Check if file exists
	info, err := os.Stat(fullPath)
	if os.IsNotExist(err) {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "File not found"})
	}

	// Delete file or folder
	if info.IsDir() {
		if err := os.RemoveAll(fullPath); err != nil {
			filesLogger.Error().Err(err).Msg("failed to delete folder")
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to delete folder"})
		}
	} else {
		if err := os.Remove(fullPath); err != nil {
			filesLogger.Error().Err(err).Msg("failed to delete file")
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to delete file"})
		}
	}

	// Clean up database
	db.DeleteFile(path)
	db.DeleteDigestsForFile(path)
	db.RemovePin(path)

	return c.JSON(http.StatusOK, map[string]string{"success": "true"})
}

// GetLibraryFileInfo handles GET /api/library/file-info
func GetLibraryFileInfo(c echo.Context) error {
	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Path is required"})
	}

	file, err := db.GetFileWithDigests(path)
	if err != nil {
		filesLogger.Error().Err(err).Msg("failed to get file info")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to get file info"})
	}

	if file == nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "File not found"})
	}

	return c.JSON(http.StatusOK, file)
}

// PinFile handles POST /api/library/pin
func PinFile(c echo.Context) error {
	var body struct {
		Path string `json:"path"`
	}
	if err := c.Bind(&body); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
	}

	if body.Path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Path is required"})
	}

	if err := db.AddPin(body.Path); err != nil {
		filesLogger.Error().Err(err).Msg("failed to pin file")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to pin file"})
	}

	return c.JSON(http.StatusOK, map[string]string{"success": "true"})
}

// UnpinFile handles DELETE /api/library/pin
func UnpinFile(c echo.Context) error {
	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Path is required"})
	}

	if err := db.RemovePin(path); err != nil {
		filesLogger.Error().Err(err).Msg("failed to unpin file")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to unpin file"})
	}

	return c.JSON(http.StatusOK, map[string]string{"success": "true"})
}

// GetLibraryTree handles GET /api/library/tree
func GetLibraryTree(c echo.Context) error {
	root := c.QueryParam("root")
	if root == "" {
		root = ""
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, root)

	// Read directory
	entries, err := os.ReadDir(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return c.JSON(http.StatusOK, []interface{}{})
		}
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to read directory"})
	}

	type TreeNode struct {
		Name     string `json:"name"`
		Path     string `json:"path"`
		IsFolder bool   `json:"isFolder"`
		Size     *int64 `json:"size,omitempty"`
	}

	var nodes []TreeNode
	for _, entry := range entries {
		name := entry.Name()

		// Skip hidden files and reserved directories
		if strings.HasPrefix(name, ".") {
			continue
		}
		if root == "" && (name == "app" || name == "inbox") {
			continue
		}

		nodePath := filepath.Join(root, name)
		info, _ := entry.Info()

		node := TreeNode{
			Name:     name,
			Path:     nodePath,
			IsFolder: entry.IsDir(),
		}

		if !entry.IsDir() && info != nil {
			size := info.Size()
			node.Size = &size
		}

		nodes = append(nodes, node)
	}

	return c.JSON(http.StatusOK, nodes)
}

// GetDirectories handles GET /api/directories
func GetDirectories(c echo.Context) error {
	cfg := config.Get()

	entries, err := os.ReadDir(cfg.DataDir)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to read directories"})
	}

	var dirs []string
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") && entry.Name() != "app" {
			dirs = append(dirs, entry.Name())
		}
	}

	return c.JSON(http.StatusOK, dirs)
}
