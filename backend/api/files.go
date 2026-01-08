package api

import (
	"compress/flate"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

// ServeRawFile handles GET /raw/*path
func ServeRawFile(c *gin.Context) {
	// Get path from URL (everything after /raw/)
	path := c.Param("path")
	// Gin includes leading slash in wildcard param
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}

	// Security: prevent directory traversal
	if strings.Contains(path, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
		return
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, path)

	// Check if file exists
	info, err := os.Stat(fullPath)
	if os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to access file"})
		return
	}

	if info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot serve directory"})
		return
	}

	// Detect MIME type
	mimeType := utils.DetectMimeType(path)

	// Set headers
	c.Header("Content-Type", mimeType)
	c.Header("Content-Length", strconv.FormatInt(info.Size(), 10))

	c.File(fullPath)
}

// SaveRawFile handles PUT /raw/*path
func SaveRawFile(c *gin.Context) {
	path := c.Param("path")
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}

	// Security: prevent directory traversal
	if strings.Contains(path, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
		return
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, path)

	// Ensure parent directory exists
	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Error().Err(err).Msg("failed to create directory")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create directory"})
		return
	}

	// Read request body
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to read request body"})
		return
	}

	// Write file
	if err := os.WriteFile(fullPath, body, 0644); err != nil {
		log.Error().Err(err).Msg("failed to write file")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write file"})
		return
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

	c.JSON(http.StatusOK, gin.H{"success": "true"})
}

// ServeSqlarFile handles GET /sqlar/*path
func ServeSqlarFile(c *gin.Context) {
	name := c.Param("path")
	name = strings.TrimPrefix(name, "/")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Name is required"})
		return
	}

	// Query sqlar table
	var sqlarFile db.SqlarFile
	err := db.GetDB().QueryRow(`
		SELECT name, mode, mtime, sz, data FROM sqlar WHERE name = ?
	`, name).Scan(&sqlarFile.Name, &sqlarFile.Mode, &sqlarFile.Mtime, &sqlarFile.Size, &sqlarFile.Data)

	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found in archive"})
		return
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

	c.Header("Content-Type", mimeType)
	c.Header("Content-Length", strconv.Itoa(len(data)))
	c.Data(http.StatusOK, mimeType, data)
}

// DeleteLibraryFile handles DELETE /api/library/file
func DeleteLibraryFile(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}

	// Security: prevent directory traversal
	if strings.Contains(path, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
		return
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, path)

	// Check if file exists
	info, err := os.Stat(fullPath)
	if os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	// Delete file or folder
	if info.IsDir() {
		if err := os.RemoveAll(fullPath); err != nil {
			log.Error().Err(err).Msg("failed to delete folder")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete folder"})
			return
		}
	} else {
		if err := os.Remove(fullPath); err != nil {
			log.Error().Err(err).Msg("failed to delete file")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete file"})
			return
		}
	}

	// Clean up database
	db.DeleteFile(path)
	db.DeleteDigestsForFile(path)
	db.RemovePin(path)

	c.JSON(http.StatusOK, gin.H{"success": "true"})
}

// GetLibraryFileInfo handles GET /api/library/file-info
func GetLibraryFileInfo(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}

	file, err := db.GetFileWithDigests(path)
	if err != nil {
		log.Error().Err(err).Msg("failed to get file info")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get file info"})
		return
	}

	if file == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	c.JSON(http.StatusOK, file)
}

// PinFile handles POST /api/library/pin
func PinFile(c *gin.Context) {
	var body struct {
		Path string `json:"path"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if body.Path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}

	if err := db.AddPin(body.Path); err != nil {
		log.Error().Err(err).Msg("failed to pin file")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to pin file"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": "true"})
}

// UnpinFile handles DELETE /api/library/pin
func UnpinFile(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}

	if err := db.RemovePin(path); err != nil {
		log.Error().Err(err).Msg("failed to unpin file")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unpin file"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": "true"})
}

// FileNode represents a file or folder in the tree (matching Node.js schema)
type FileNode struct {
	Name       string      `json:"name"`
	Path       string      `json:"path"`
	Type       string      `json:"type"` // "file" or "folder"
	Size       *int64      `json:"size,omitempty"`
	ModifiedAt *string     `json:"modifiedAt,omitempty"`
	Children   []FileNode  `json:"children,omitempty"`
}

// GetLibraryTree handles GET /api/library/tree
// Matches Node.js schema: uses ?path= parameter and returns {path, nodes}
func GetLibraryTree(c *gin.Context) {
	// Node.js uses "path" parameter, not "root"
	requestedPath := c.Query("path")
	if requestedPath == "" {
		requestedPath = ""
	}

	// Security: Normalize and validate path
	requestedPath = filepath.Clean(requestedPath)
	if strings.HasPrefix(requestedPath, "..") || filepath.IsAbs(requestedPath) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
		return
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, requestedPath)

	// Read directory
	entries, err := os.ReadDir(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusOK, gin.H{"path": requestedPath, "nodes": []FileNode{}})
			return
		}
		log.Error().Err(err).Str("path", fullPath).Msg("failed to read directory tree")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read directory tree"})
		return
	}

	var nodes []FileNode
	for _, entry := range entries {
		name := entry.Name()

		// Skip hidden files and reserved directories
		if strings.HasPrefix(name, ".") {
			continue
		}
		if name == "node_modules" || name == ".git" {
			continue
		}
		// Skip app and inbox at root level
		if requestedPath == "" && (name == "app" || name == "inbox") {
			continue
		}

		var nodePath string
		if requestedPath == "" {
			nodePath = name
		} else {
			nodePath = requestedPath + "/" + name
		}

		info, _ := entry.Info()

		nodeType := "folder"
		var size *int64
		var modifiedAt *string

		if !entry.IsDir() {
			nodeType = "file"
			if info != nil {
				s := info.Size()
				size = &s
				modTime := info.ModTime().UTC().Format(time.RFC3339)
				modifiedAt = &modTime
			}
		}

		node := FileNode{
			Name:       name,
			Path:       nodePath,
			Type:       nodeType,
			Size:       size,
			ModifiedAt: modifiedAt,
			Children:   []FileNode{}, // Empty children array for folders
		}

		nodes = append(nodes, node)
	}

	// Sort: folders first, then files, alphabetically within each type
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Type != nodes[j].Type {
			return nodes[i].Type == "folder"
		}
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})

	// Return response matching Node.js schema
	c.JSON(http.StatusOK, gin.H{
		"path":  requestedPath,
		"nodes": nodes,
	})
}

// GetDirectories handles GET /api/directories
func GetDirectories(c *gin.Context) {
	cfg := config.Get()

	entries, err := os.ReadDir(cfg.DataDir)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read directories"})
		return
	}

	var dirs []string
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") && entry.Name() != "app" {
			dirs = append(dirs, entry.Name())
		}
	}

	c.JSON(http.StatusOK, dirs)
}
