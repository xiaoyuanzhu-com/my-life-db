package api

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"fmt"
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
		RespondCoded(c, http.StatusNotFound, "LIBRARY_NOT_FOUND", "File not found")
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to access file"})
		return
	}

	if info.IsDir() {
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_INVALID_PATH", "Cannot serve directory")
		return
	}

	// Detect MIME type
	mimeType := utils.DetectMimeType(path)

	// Set cache headers for static assets
	// Cache for 1 day - revalidation is cheap with 304 responses
	setCacheHeaders(c, path, info.ModTime(), false)

	// Set ETag before calling ServeContent (required for conditional requests)
	etag := fmt.Sprintf(`"%d-%s"`, info.ModTime().Unix(), computePathHash(path))
	c.Header("ETag", etag)

	// Use http.ServeContent which handles conditional requests automatically
	// This built-in function checks If-None-Match and If-Modified-Since for us
	file, err := os.Open(fullPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open file"})
		return
	}
	defer file.Close()

	c.Header("Content-Type", mimeType)
	http.ServeContent(c.Writer, c.Request, filepath.Base(path), info.ModTime(), file)
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

	c.JSON(http.StatusOK, gin.H{"success": true})
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

	// Set cache headers for SQLAR files (these are immutable digest outputs)
	// Use mtime from SQLAR as modification time
	modTime := time.Unix(int64(sqlarFile.Mtime), 0)
	// SQLAR files are digest outputs that never change, use immutable cache
	setCacheHeaders(c, name, modTime, true)

	// Set ETag for conditional requests
	etag := fmt.Sprintf(`"%d-%s"`, modTime.Unix(), computePathHash(name))
	c.Header("ETag", etag)

	c.Header("Content-Type", mimeType)

	// Use http.ServeContent for automatic conditional request handling
	// It checks If-None-Match/If-Modified-Since and returns 304 when appropriate
	http.ServeContent(c.Writer, c.Request, name, modTime, bytes.NewReader(data))
}

// DeleteLibraryFile handles DELETE /api/library/file
func (h *Handlers) DeleteLibraryFile(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_PATH_REQUIRED", "Path is required")
		return
	}

	// Security: prevent directory traversal
	if strings.Contains(path, "..") {
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_INVALID_PATH", "Invalid path")
		return
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.UserDataDir, path)

	// Check if file exists
	info, err := os.Stat(fullPath)
	if os.IsNotExist(err) {
		RespondCoded(c, http.StatusNotFound, "LIBRARY_NOT_FOUND", "File not found")
		return
	}

	// Delete via fs.Service (handles filesystem, DB cascade, logging)
	if info.IsDir() {
		if err := h.server.FS().DeleteFolder(c.Request.Context(), path); err != nil {
			log.Error().Err(err).Str("path", path).Msg("failed to delete folder")
			RespondCoded(c, http.StatusInternalServerError, "LIBRARY_DELETE_FAILED", "Failed to delete file")
			return
		}
	} else {
		if err := h.server.FS().DeleteFile(c.Request.Context(), path); err != nil {
			log.Error().Err(err).Str("path", path).Msg("failed to delete file")
			RespondCoded(c, http.StatusInternalServerError, "LIBRARY_DELETE_FAILED", "Failed to delete file")
			return
		}
	}

	// Notify clients of the change
	h.server.Notifications().NotifyLibraryChanged(path, "delete")

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// DownloadLibraryPath handles GET /api/library/download
// Files: serves with Content-Disposition attachment
// Folders: streams a zip archive
func (h *Handlers) DownloadLibraryPath(c *gin.Context) {
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

	info, err := os.Stat(fullPath)
	if os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to stat path"})
		return
	}

	if info.IsDir() {
		h.downloadFolder(c, fullPath, filepath.Base(path))
	} else {
		h.downloadFile(c, fullPath, filepath.Base(path))
	}
}

func (h *Handlers) downloadFile(c *gin.Context, fullPath, name string) {
	f, err := os.Open(fullPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open file"})
		return
	}
	defer f.Close()

	info, _ := f.Stat()
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	http.ServeContent(c.Writer, c.Request, name, info.ModTime(), f)
}

func (h *Handlers) downloadFolder(c *gin.Context, fullPath, name string) {
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.zip"`, name))

	zw := zip.NewWriter(c.Writer)
	defer zw.Close()

	err := filepath.Walk(fullPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		// Skip directories as entries (they're implied by file paths)
		if info.IsDir() {
			return nil
		}

		relPath, err := filepath.Rel(fullPath, path)
		if err != nil {
			return err
		}

		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = filepath.Join(name, relPath)
		header.Method = zip.Deflate

		w, err := zw.CreateHeader(header)
		if err != nil {
			return err
		}

		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()

		_, err = io.Copy(w, f)
		return err
	})

	if err != nil {
		log.Error().Err(err).Str("path", fullPath).Msg("failed to create zip archive")
	}
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

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// FileNode represents a file or folder in the tree (recursive structure)
type FileNode struct {
	Path         string     `json:"path,omitempty"`
	Type         string     `json:"type,omitempty"` // "file" or "folder"
	Size         *int64     `json:"size,omitempty"`
	ModifiedAt   *int64     `json:"modifiedAt,omitempty"`
	CreatedAt    *int64     `json:"createdAt,omitempty"`
	PreviewSqlar *string    `json:"previewSqlar,omitempty"`
	Children     []FileNode `json:"children,omitempty"`
}

// flatFileResult represents a file/folder in flat search results
type flatFileResult struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

// fieldSet tracks which fields to include in the response
type fieldSet map[string]bool

func parseFields(fieldsParam string) fieldSet {
	fields := make(fieldSet)
	if fieldsParam == "" {
		// Default: all fields for backward compatibility
		fields["path"] = true
		fields["type"] = true
		fields["size"] = true
		fields["modifiedAt"] = true
		fields["createdAt"] = true
		fields["previewSqlar"] = true
		return fields
	}
	for _, f := range strings.Split(fieldsParam, ",") {
		fields[strings.TrimSpace(f)] = true
	}
	return fields
}

// GetLibraryTree handles GET /api/library/tree
// Parameters:
//   - path: directory path to list, absolute or relative to UserDataDir (default: root)
//   - depth: recursion depth, 1=direct children, 0=unlimited (default: 1)
//   - limit: max nodes to return (default: unlimited)
//   - fields: comma-separated fields to include (default: all)
//   - folderOnly: if true, return folders only (default: false)
//   - query: search query for server-side filtering (returns flat results)
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

	// Parse folder filter
	foldersOnly := c.Query("folderOnly") == "true"

	// Parse fields
	fields := parseFields(c.Query("fields"))

	// Parse search query
	query := c.Query("query")

	// Normalize and validate path
	var baseDir, fullPath string
	cfg := config.Get()

	if requestedPath != "" {
		requestedPath = filepath.Clean(requestedPath)
		if strings.Contains(requestedPath, "..") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
			return
		}
	}

	if filepath.IsAbs(requestedPath) {
		// Absolute path: use directly
		baseDir = requestedPath
		fullPath = requestedPath
		requestedPath = "" // relative path within baseDir is empty
	} else {
		// Relative path: join with UserDataDir
		baseDir = cfg.UserDataDir
		fullPath = filepath.Join(cfg.UserDataDir, requestedPath)
	}

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

	// Server-side search mode: walk entire tree, fuzzy-match, return flat results
	if query != "" {
		results, totalWalked := h.searchFiles(fullPath, requestedPath, query, limit, foldersOnly)
		c.JSON(http.StatusOK, gin.H{
			"basePath":   baseDir,
			"path":       requestedPath,
			"files":      results,
			"totalCount": totalWalked,
			"truncated":  limit > 0 && len(results) >= limit,
		})
		return
	}

	// Track count for limit
	count := 0
	children := h.readDirRecursive(baseDir, requestedPath, depth, 1, fields, &count, limit, foldersOnly)

	response := gin.H{
		"basePath": baseDir,
		"path":     requestedPath,
		"children": children,
	}
	if limit > 0 {
		response["truncated"] = count >= limit
	}

	c.JSON(http.StatusOK, response)
}

// searchFiles walks the directory tree and returns flat results matching the query.
// It uses case-insensitive substring matching on the full relative path and filename.
func (h *Handlers) searchFiles(rootPath, requestedPath, query string, limit int, foldersOnly bool) ([]flatFileResult, int) {
	lowerQuery := strings.ToLower(query)
	var results []flatFileResult
	totalWalked := 0

	var walk func(dir, relPath string)
	walk = func(dir, relPath string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}

		for _, entry := range entries {
			name := entry.Name()

			isDir := entry.IsDir()
			if foldersOnly && !isDir {
				continue
			}

			var childRelPath string
			if relPath == "" {
				childRelPath = name
			} else {
				childRelPath = relPath + "/" + name
			}

			totalWalked++

			// Match against full path and filename
			lowerPath := strings.ToLower(childRelPath)
			lowerName := strings.ToLower(name)
			if strings.Contains(lowerPath, lowerQuery) || strings.Contains(lowerName, lowerQuery) {
				nodeType := "file"
				if isDir {
					nodeType = "folder"
				}
				results = append(results, flatFileResult{
					Path: childRelPath,
					Type: nodeType,
				})
			}

			// Always recurse into directories
			if isDir {
				walk(filepath.Join(dir, name), childRelPath)
			}
		}
	}

	walk(rootPath, "")

	// Sort: prefer filename matches over path-only matches, then alphabetically
	sort.Slice(results, func(i, j int) bool {
		iName := strings.ToLower(filepath.Base(results[i].Path))
		jName := strings.ToLower(filepath.Base(results[j].Path))
		iNameMatch := strings.Contains(iName, lowerQuery)
		jNameMatch := strings.Contains(jName, lowerQuery)
		if iNameMatch != jNameMatch {
			return iNameMatch
		}
		return results[i].Path < results[j].Path
	})

	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}

	return results, totalWalked
}

// readDirRecursive reads directory contents recursively up to specified depth
func (h *Handlers) readDirRecursive(baseDir, relativePath string, maxDepth, currentDepth int, fields fieldSet, count *int, limit int, foldersOnly bool) []FileNode {
	fullPath := filepath.Join(baseDir, relativePath)

	entries, err := os.ReadDir(fullPath)
	if err != nil {
		return []FileNode{}
	}

	// Batch-load preview info if requested
	var previewMap map[string]string
	if fields["previewSqlar"] {
		previewMap, _ = db.GetPreviewSqlarMap(relativePath)
	}

	// Batch-load DB created_at if requested. created_at is the time MyLifeDB
	// first indexed the file — used as a sortable "added to library" proxy
	// since filesystem birthtime is not reliable on Linux/Docker.
	var createdAtMap map[string]int64
	if fields["createdAt"] {
		createdAtMap, _ = db.GetCreatedAtMap(relativePath)
	}

	var nodes []FileNode
	for _, entry := range entries {
		name := entry.Name()

		isDir := entry.IsDir()

		// Skip files if foldersOnly is true
		if foldersOnly && !isDir {
			continue
		}

		// Full path for recursion (relative to baseDir)
		var childRelPath string
		if relativePath == "" {
			childRelPath = name
		} else {
			childRelPath = relativePath + "/" + name
		}

		// Check limit
		if limit > 0 && *count >= limit {
			break
		}

		info, _ := entry.Info()

		// Build node with requested fields only
		node := FileNode{}

		if fields["path"] {
			node.Path = name // Only the name, not full path (parent context is implicit)
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
			modTime := info.ModTime().UnixMilli()
			node.ModifiedAt = &modTime
		}
		if fields["createdAt"] {
			if ts, ok := createdAtMap[name]; ok {
				node.CreatedAt = &ts
			}
		}
		if fields["previewSqlar"] && !isDir {
			if sqlar, ok := previewMap[name]; ok {
				node.PreviewSqlar = &sqlar
			}
		}

		// Recurse into directories if depth allows
		if isDir {
			// maxDepth: 0 = unlimited, otherwise check current depth
			if maxDepth == 0 || currentDepth < maxDepth {
				node.Children = h.readDirRecursive(baseDir, childRelPath, maxDepth, currentDepth+1, fields, count, limit, foldersOnly)
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
		return strings.ToLower(nodes[i].Path) < strings.ToLower(nodes[j].Path)
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

// GetLibraryRoot handles GET /api/library/root
func (h *Handlers) GetLibraryRoot(c *gin.Context) {
	cfg := config.Get()
	c.JSON(http.StatusOK, gin.H{"root": cfg.UserDataDir})
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
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_PATH_REQUIRED", "Path and newName are required")
		return
	}

	// Security: prevent directory traversal
	if strings.Contains(body.Path, "..") || strings.Contains(body.NewName, "..") || strings.Contains(body.NewName, "/") {
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_INVALID_PATH", "Invalid path or name")
		return
	}

	cfg := config.Get()

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
		RespondCoded(c, http.StatusConflict, "LIBRARY_FILE_CONFLICT", "A file with this name already exists")
		return
	}

	// Rename via fs.Service (handles filesystem, DB, search sync, logging)
	if err := h.server.FS().RenameOrMove(c.Request.Context(), body.Path, newPath); err != nil {
		log.Error().Err(err).Str("path", body.Path).Str("newPath", newPath).Msg("failed to rename file")
		RespondCoded(c, http.StatusInternalServerError, "LIBRARY_RENAME_FAILED", "Failed to rename file")
		return
	}

	// Notify clients of the change
	h.server.Notifications().NotifyLibraryChanged(newPath, "rename")

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
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_PATH_REQUIRED", "Path is required")
		return
	}

	// Security: prevent directory traversal
	if strings.Contains(body.Path, "..") || strings.Contains(body.TargetPath, "..") {
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_INVALID_PATH", "Invalid path")
		return
	}

	cfg := config.Get()

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
		RespondCoded(c, http.StatusConflict, "LIBRARY_FILE_CONFLICT", "A file with this name already exists in the target location")
		return
	}

	// Move via fs.Service (handles filesystem, DB, search sync, logging, parent dir creation)
	if err := h.server.FS().RenameOrMove(c.Request.Context(), body.Path, newPath); err != nil {
		log.Error().Err(err).Str("path", body.Path).Str("newPath", newPath).Msg("failed to move file")
		RespondCoded(c, http.StatusInternalServerError, "LIBRARY_MOVE_FAILED", "Failed to move file")
		return
	}

	// Notify clients of the change
	h.server.Notifications().NotifyLibraryChanged(newPath, "move")

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
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_PATH_REQUIRED", "Folder name is required")
		return
	}

	// Security: prevent directory traversal
	if strings.Contains(body.Path, "..") || strings.Contains(body.Name, "..") || strings.Contains(body.Name, "/") {
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_INVALID_PATH", "Invalid path or name")
		return
	}

	// Build full path
	var folderPath string
	if body.Path == "" {
		folderPath = body.Name
	} else {
		folderPath = body.Path + "/" + body.Name
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.UserDataDir, folderPath)

	// Check if already exists
	if _, err := os.Stat(fullPath); !os.IsNotExist(err) {
		RespondCoded(c, http.StatusConflict, "LIBRARY_FOLDER_CONFLICT", "A folder with this name already exists")
		return
	}

	// Create folder via fs.Service (handles filesystem + DB + logging)
	if err := h.server.FS().CreateFolder(c.Request.Context(), folderPath); err != nil {
		log.Error().Err(err).Str("path", folderPath).Msg("failed to create folder")
		RespondCoded(c, http.StatusInternalServerError, "LIBRARY_CREATE_FOLDER_FAILED", "Failed to create folder")
		return
	}

	// Notify clients of the change
	h.server.Notifications().NotifyLibraryChanged(folderPath, "create")

	c.JSON(http.StatusOK, gin.H{"path": folderPath})
}

// =============================================================================
// HTTP Caching Helpers
// =============================================================================

// setCacheHeaders sets appropriate cache headers for static assets
// This implements industry best practices for HTTP caching across all platforms
func setCacheHeaders(c *gin.Context, path string, modTime time.Time, isImmutable bool) {
	// Generate ETag from modification time + path
	// This provides a unique identifier that changes when file content changes
	etag := fmt.Sprintf(`"%d-%s"`, modTime.Unix(), computePathHash(path))
	c.Header("ETag", etag)

	// Set Last-Modified header (RFC 7232)
	// Format: Wed, 21 Oct 2015 07:28:00 GMT
	c.Header("Last-Modified", modTime.UTC().Format(http.TimeFormat))

	// Cache-Control: public means the response can be cached by any cache (browser, CDN, proxy)
	//
	// For user-uploaded files: max-age=1 day (revalidatable)
	// - Files rarely change, but we check daily for peace of mind
	// - 304 responses are cheap (~300 bytes, ~10-50ms)
	// - ETag changes automatically if file is modified
	// - Good balance between freshness and efficiency
	//
	// For digest outputs (SQLAR): max-age=1 year + immutable
	// - These files NEVER change (they're content-addressed)
	// - immutable directive = browser won't even revalidate
	// - Maximum performance with zero staleness risk
	if isImmutable {
		c.Header("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		c.Header("Cache-Control", "public, max-age=86400") // 1 day
	}

	// Vary header tells caches to consider Accept-Encoding when caching
	// (important for gzip/brotli compression)
	c.Header("Vary", "Accept-Encoding")
}

// Note: We use Go's built-in http.ServeContent() for conditional request handling
// It automatically checks If-None-Match (ETag) and If-Modified-Since headers
// and returns 304 Not Modified when appropriate. No custom logic needed!

// computePathHash creates a simple hash of the path for ETag generation
// This ensures ETag uniqueness across different files with same modification time
func computePathHash(path string) string {
	// Simple FNV-1a hash implementation
	hash := uint32(2166136261)
	for i := 0; i < len(path); i++ {
		hash ^= uint32(path[i])
		hash *= 16777619
	}
	return strconv.FormatUint(uint64(hash), 36)
}
