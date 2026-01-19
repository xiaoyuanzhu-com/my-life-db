package api

import (
	"bytes"
	"compress/zlib"
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
	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

// ServeRawFile handles GET /raw/*path
func (h *Handlers) ServeRawFile(c *gin.Context) {
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
	fullPath := filepath.Join(cfg.UserDataDir, path)

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
func (h *Handlers) SaveRawFile(c *gin.Context) {
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

	// Use fs.Service.WriteFile() - single entry point for all file operations
	// This handles: file locking, metadata computation (hash, text preview), DB upsert, digest notification
	mimeType := utils.DetectMimeType(path)
	result, err := h.server.FS().WriteFile(c.Request.Context(), fs.WriteRequest{
		Path:            path,
		Content:         c.Request.Body,
		MimeType:        mimeType,
		Source:          "raw-api",
		ComputeMetadata: true,
		Sync:            true, // Compute metadata synchronously for immediate availability
	})
	if err != nil {
		log.Error().Err(err).Str("path", path).Msg("failed to write file")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write file"})
		return
	}

	log.Info().
		Str("path", path).
		Bool("isNew", result.IsNew).
		Bool("hashComputed", result.HashComputed).
		Msg("raw file saved")

	c.JSON(http.StatusOK, gin.H{"success": "true"})
}

// ServeSqlarFile handles GET /sqlar/*path
func (h *Handlers) ServeSqlarFile(c *gin.Context) {
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
		// Data is compressed with zlib
		reader, err := zlib.NewReader(bytes.NewReader(sqlarFile.Data))
		if err != nil {
			log.Error().Err(err).Str("name", name).Msg("failed to create zlib reader")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to decompress file"})
			return
		}
		defer reader.Close()

		data, err = io.ReadAll(reader)
		if err != nil {
			log.Error().Err(err).Str("name", name).Msg("failed to decompress data")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to decompress file"})
			return
		}
	} else {
		// Data is uncompressed
		data = sqlarFile.Data
	}

	// Detect MIME type
	mimeType := utils.DetectMimeType(name)

	c.Header("Content-Type", mimeType)
	c.Header("Content-Length", strconv.Itoa(len(data)))
	c.Data(http.StatusOK, mimeType, data)
}

// DeleteLibraryFile handles DELETE /api/library/file
func (h *Handlers) DeleteLibraryFile(c *gin.Context) {
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
	fullPath := filepath.Join(cfg.UserDataDir, path)

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
func (h *Handlers) GetLibraryFileInfo(c *gin.Context) {
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
// Toggles pin state like Node.js version and returns the new state
func (h *Handlers) PinFile(c *gin.Context) {
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

	// Check current pin state
	isPinned, err := db.IsPinned(body.Path)
	if err != nil {
		log.Error().Err(err).Msg("failed to check pin state")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to check pin state"})
		return
	}

	// Toggle pin state
	if isPinned {
		if err := db.RemovePin(body.Path); err != nil {
			log.Error().Err(err).Msg("failed to unpin file")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unpin file"})
			return
		}
		isPinned = false
	} else {
		if err := db.AddPin(body.Path); err != nil {
			log.Error().Err(err).Msg("failed to pin file")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to pin file"})
			return
		}
		isPinned = true
	}

	log.Info().Str("path", body.Path).Bool("isPinned", isPinned).Msg("toggled pin state")

	// Notify UI of pin change
	h.server.Notifications().NotifyPinChanged(body.Path)

	// Return the new pin state (matching Node.js response format)
	c.JSON(http.StatusOK, gin.H{"isPinned": isPinned})
}

// UnpinFile handles DELETE /api/library/pin
func (h *Handlers) UnpinFile(c *gin.Context) {
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
	Name       string     `json:"name"`
	Path       string     `json:"path"`
	Type       string     `json:"type"` // "file" or "folder"
	Size       *int64     `json:"size,omitempty"`
	ModifiedAt *string    `json:"modifiedAt,omitempty"`
	Children   []FileNode `json:"children,omitempty"`
}

// GetLibraryTree handles GET /api/library/tree
// Matches Node.js schema: uses ?path= parameter and returns {path, nodes}
func (h *Handlers) GetLibraryTree(c *gin.Context) {
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
	fullPath := filepath.Join(cfg.UserDataDir, requestedPath)

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
func (h *Handlers) GetDirectories(c *gin.Context) {
	cfg := config.Get()

	entries, err := os.ReadDir(cfg.UserDataDir)
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

// RenameLibraryFile handles POST /api/library/rename
func (h *Handlers) RenameLibraryFile(c *gin.Context) {
	var body struct {
		Path    string `json:"path"`
		NewName string `json:"newName"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if body.Path == "" || body.NewName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path and newName are required"})
		return
	}

	// Security: prevent directory traversal
	if strings.Contains(body.Path, "..") || strings.Contains(body.NewName, "..") || strings.Contains(body.NewName, "/") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path or name"})
		return
	}

	cfg := config.Get()
	oldFullPath := filepath.Join(cfg.UserDataDir, body.Path)

	// Check if source exists
	info, err := os.Stat(oldFullPath)
	if os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	// Build new path
	parentDir := filepath.Dir(body.Path)
	var newPath string
	if parentDir == "." {
		newPath = body.NewName
	} else {
		newPath = parentDir + "/" + body.NewName
	}
	newFullPath := filepath.Join(cfg.UserDataDir, newPath)

	// Check if destination already exists
	if _, err := os.Stat(newFullPath); !os.IsNotExist(err) {
		c.JSON(http.StatusConflict, gin.H{"error": "A file with this name already exists"})
		return
	}

	// Rename on filesystem
	if err := os.Rename(oldFullPath, newFullPath); err != nil {
		log.Error().Err(err).Msg("failed to rename file")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to rename file"})
		return
	}

	// Update database records
	if info.IsDir() {
		// For folders, update all paths that start with the old path
		db.RenameFilePaths(body.Path, newPath)
	} else {
		// For files, just update the single record
		db.RenameFilePath(body.Path, newPath, body.NewName)
	}

	c.JSON(http.StatusOK, gin.H{"newPath": newPath})
}

// MoveLibraryFile handles POST /api/library/move
func (h *Handlers) MoveLibraryFile(c *gin.Context) {
	var body struct {
		Path       string `json:"path"`
		TargetPath string `json:"targetPath"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if body.Path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}

	// Security: prevent directory traversal
	if strings.Contains(body.Path, "..") || strings.Contains(body.TargetPath, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
		return
	}

	cfg := config.Get()
	oldFullPath := filepath.Join(cfg.UserDataDir, body.Path)

	// Check if source exists
	info, err := os.Stat(oldFullPath)
	if os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	// Get file name
	fileName := filepath.Base(body.Path)

	// Build new path
	var newPath string
	if body.TargetPath == "" {
		newPath = fileName
	} else {
		newPath = body.TargetPath + "/" + fileName
	}
	newFullPath := filepath.Join(cfg.UserDataDir, newPath)

	// Check if destination already exists
	if _, err := os.Stat(newFullPath); !os.IsNotExist(err) {
		c.JSON(http.StatusConflict, gin.H{"error": "A file with this name already exists in the target location"})
		return
	}

	// Ensure target directory exists
	targetDir := filepath.Dir(newFullPath)
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		log.Error().Err(err).Msg("failed to create target directory")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create target directory"})
		return
	}

	// Move on filesystem
	if err := os.Rename(oldFullPath, newFullPath); err != nil {
		log.Error().Err(err).Msg("failed to move file")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to move file"})
		return
	}

	// Update database records
	if info.IsDir() {
		db.RenameFilePaths(body.Path, newPath)
	} else {
		db.RenameFilePath(body.Path, newPath, fileName)
	}

	c.JSON(http.StatusOK, gin.H{"newPath": newPath})
}

// CreateLibraryFolder handles POST /api/library/folder
func (h *Handlers) CreateLibraryFolder(c *gin.Context) {
	var body struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if body.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Folder name is required"})
		return
	}

	// Security: prevent directory traversal
	if strings.Contains(body.Path, "..") || strings.Contains(body.Name, "..") || strings.Contains(body.Name, "/") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path or name"})
		return
	}

	cfg := config.Get()

	// Build full path
	var folderPath string
	if body.Path == "" {
		folderPath = body.Name
	} else {
		folderPath = body.Path + "/" + body.Name
	}
	fullPath := filepath.Join(cfg.UserDataDir, folderPath)

	// Check if already exists
	if _, err := os.Stat(fullPath); !os.IsNotExist(err) {
		c.JSON(http.StatusConflict, gin.H{"error": "A folder with this name already exists"})
		return
	}

	// Create folder
	if err := os.MkdirAll(fullPath, 0755); err != nil {
		log.Error().Err(err).Msg("failed to create folder")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create folder"})
		return
	}

	// Add to database
	now := db.NowUTC()
	db.UpsertFile(&db.FileRecord{
		Path:          folderPath,
		Name:          body.Name,
		IsFolder:      true,
		ModifiedAt:    now,
		CreatedAt:     now,
		LastScannedAt: now,
	})

	c.JSON(http.StatusOK, gin.H{"path": folderPath})
}
