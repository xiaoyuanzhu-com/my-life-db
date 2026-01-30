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

// FileNode represents a file or folder in the tree (recursive structure)
type FileNode struct {
	Name       string     `json:"name,omitempty"`
	Path       string     `json:"path,omitempty"`
	Type       string     `json:"type,omitempty"` // "file" or "folder"
	Size       *int64     `json:"size,omitempty"`
	ModifiedAt *string    `json:"modifiedAt,omitempty"`
	Children   []FileNode `json:"children,omitempty"`
}

// fieldSet tracks which fields to include in the response
type fieldSet map[string]bool

func parseFields(fieldsParam string) fieldSet {
	fields := make(fieldSet)
	if fieldsParam == "" {
		// Default: all fields for backward compatibility
		fields["name"] = true
		fields["path"] = true
		fields["type"] = true
		fields["size"] = true
		fields["modifiedAt"] = true
		return fields
	}
	for _, f := range strings.Split(fieldsParam, ",") {
		fields[strings.TrimSpace(f)] = true
	}
	return fields
}

// GetLibraryTree handles GET /api/library/tree
// Parameters:
//   - path: directory path to list (default: root)
//   - depth: recursion depth, 1=direct children, 0=unlimited (default: 1)
//   - limit: max nodes to return (default: unlimited)
//   - fields: comma-separated fields to include (default: path,type)
func (h *Handlers) GetLibraryTree(c *gin.Context) {
	requestedPath := c.Query("path")

	// Parse depth (default: 1)
	depth := 1
	if depthStr := c.Query("depth"); depthStr != "" {
		if d, err := strconv.Atoi(depthStr); err == nil {
			depth = d
		}
	}

	// Parse limit (default: 0 = unlimited)
	limit := 0
	if limitStr := c.Query("limit"); limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 {
			limit = l
		}
	}

	// Parse fields
	fields := parseFields(c.Query("fields"))

	// Security: Normalize and validate path
	if requestedPath != "" {
		requestedPath = filepath.Clean(requestedPath)
		if strings.HasPrefix(requestedPath, "..") || filepath.IsAbs(requestedPath) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
			return
		}
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.UserDataDir, requestedPath)

	// Check if path exists
	info, err := os.Stat(fullPath)
	if os.IsNotExist(err) {
		c.JSON(http.StatusOK, gin.H{"path": requestedPath, "children": []FileNode{}})
		return
	}
	if err != nil || !info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is not a directory"})
		return
	}

	// Track count for limit
	count := 0
	children := h.readDirRecursive(cfg.UserDataDir, requestedPath, depth, 1, fields, &count, limit)

	c.JSON(http.StatusOK, gin.H{
		"path":     requestedPath,
		"children": children,
	})
}

// readDirRecursive reads directory contents recursively up to specified depth
func (h *Handlers) readDirRecursive(baseDir, relativePath string, maxDepth, currentDepth int, fields fieldSet, count *int, limit int) []FileNode {
	fullPath := filepath.Join(baseDir, relativePath)

	entries, err := os.ReadDir(fullPath)
	if err != nil {
		return []FileNode{}
	}

	var nodes []FileNode
	for _, entry := range entries {
		// Check limit
		if limit > 0 && *count >= limit {
			break
		}

		name := entry.Name()

		// Skip hidden files and reserved directories
		if strings.HasPrefix(name, ".") {
			continue
		}
		if name == "node_modules" {
			continue
		}
		// Skip app and inbox at root level
		if relativePath == "" && (name == "app" || name == "inbox") {
			continue
		}

		var nodePath string
		if relativePath == "" {
			nodePath = name
		} else {
			nodePath = relativePath + "/" + name
		}

		info, _ := entry.Info()
		isDir := entry.IsDir()

		// Build node with requested fields only
		node := FileNode{}

		if fields["name"] {
			node.Name = name
		}
		if fields["path"] {
			node.Path = nodePath
		}
		if fields["type"] {
			if isDir {
				node.Type = "folder"
			} else {
				node.Type = "file"
			}
		}
		if fields["size"] && !isDir && info != nil {
			s := info.Size()
			node.Size = &s
		}
		if fields["modifiedAt"] && info != nil {
			modTime := info.ModTime().UTC().Format(time.RFC3339)
			node.ModifiedAt = &modTime
		}

		// Recurse into directories if depth allows
		if isDir {
			// maxDepth: 0 = unlimited, otherwise check current depth
			if maxDepth == 0 || currentDepth < maxDepth {
				node.Children = h.readDirRecursive(baseDir, nodePath, maxDepth, currentDepth+1, fields, count, limit)
			} else {
				node.Children = []FileNode{} // Empty array for unexpanded folders
			}
		}

		*count++
		nodes = append(nodes, node)
	}

	// Sort: folders first, then files, alphabetically within each type
	sort.Slice(nodes, func(i, j int) bool {
		iIsFolder := nodes[i].Type == "folder" || len(nodes[i].Children) > 0 || (nodes[i].Type == "" && nodes[i].Size == nil)
		jIsFolder := nodes[j].Type == "folder" || len(nodes[j].Children) > 0 || (nodes[j].Type == "" && nodes[j].Size == nil)
		if iIsFolder != jIsFolder {
			return iIsFolder
		}
		// Sort by path if available, otherwise by name
		iName := nodes[i].Path
		if iName == "" {
			iName = nodes[i].Name
		}
		jName := nodes[j].Path
		if jName == "" {
			jName = nodes[j].Name
		}
		return strings.ToLower(iName) < strings.ToLower(jName)
	})

	return nodes
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
