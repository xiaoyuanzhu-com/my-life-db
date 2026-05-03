package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// This file contains adapter handlers for the new RESTful /api/data/* paths
// introduced by the API namespace refactor (see internal/api/api-structure.md).
//
// The "old shape" handlers in files.go remain registered at /api/library/*
// during the alias window (Phases B-C). When Phase D removes the aliases,
// the old handlers can be removed and these adapters become canonical.
//
// For routes whose URL+body shape is unchanged (only the URL prefix differs)
// the same handler is registered at both old and new paths in routes.go;
// no adapter is needed for those.

// trimPathParam strips the leading slash that gin's catch-all (*path) keeps.
func trimPathParam(c *gin.Context) string {
	return strings.TrimPrefix(c.Param("path"), "/")
}

// validateRelPath rejects empty, traversal, or absolute paths.
// Returns true on success; on failure, writes a 400 response and returns false.
func validateRelPath(c *gin.Context, p string) bool {
	if p == "" {
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_PATH_REQUIRED", "Path is required")
		return false
	}
	if strings.Contains(p, "..") {
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_INVALID_PATH", "Invalid path")
		return false
	}
	return true
}

// =============================================================================
// /api/data/files/*path
// =============================================================================

// GetDataFile handles GET /api/data/files/*path — file/folder metadata.
// REST shape mirror of GetLibraryFileInfo (which reads ?path=...).
func (h *Handlers) GetDataFile(c *gin.Context) {
	path := trimPathParam(c)
	if !validateRelPath(c, path) {
		return
	}

	file, err := h.server.IndexDB().GetFileByPath(path)
	if err != nil {
		log.Error().Err(err).Msg("failed to get file info")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get file info"})
		return
	}
	if file == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	isPinned := false
	if pinned, perr := h.server.AppDB().IsPinned(path); perr == nil {
		isPinned = pinned
	}

	c.JSON(http.StatusOK, gin.H{
		"path":          file.Path,
		"name":          file.Name,
		"isFolder":      file.IsFolder,
		"size":          file.Size,
		"mimeType":      file.MimeType,
		"hash":          file.Hash,
		"modifiedAt":    file.ModifiedAt,
		"createdAt":     file.CreatedAt,
		"lastScannedAt": file.LastScannedAt,
		"textPreview":   file.TextPreview,
		"previewSqlar":  file.PreviewSqlar,
		"previewStatus": file.PreviewStatus,
		"isPinned":      isPinned,
	})
}

// DeleteDataFile handles DELETE /api/data/files/*path.
// REST shape mirror of DeleteLibraryFile (which reads ?path=...).
func (h *Handlers) DeleteDataFile(c *gin.Context) {
	path := trimPathParam(c)
	if !validateRelPath(c, path) {
		return
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.UserDataDir, path)

	info, err := os.Stat(fullPath)
	if err != nil && os.IsNotExist(err) {
		RespondCoded(c, http.StatusNotFound, "LIBRARY_NOT_FOUND", "File not found")
		return
	}

	if info != nil && info.IsDir() {
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

	h.server.Notifications().NotifyLibraryChanged(path, "delete")
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// PatchDataFile handles PATCH /api/data/files/*path.
// Body discriminator:
//   - {"name": "new-name"} → rename in place
//   - {"parent": "new/parent/dir"} → move to new parent (keep name)
//
// Mirror of RenameLibraryFile + MoveLibraryFile (which read body {path, ...}).
func (h *Handlers) PatchDataFile(c *gin.Context) {
	path := trimPathParam(c)
	if !validateRelPath(c, path) {
		return
	}

	var body struct {
		Name   *string `json:"name"`
		Parent *string `json:"parent"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if body.Name != nil && body.Parent != nil {
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_INVALID_PATCH",
			"Specify either 'name' (rename) or 'parent' (move), not both")
		return
	}

	cfg := config.Get()

	// Compute new path based on which discriminator was provided.
	var newPath string
	switch {
	case body.Name != nil:
		newName := *body.Name
		if newName == "" {
			RespondCoded(c, http.StatusBadRequest, "LIBRARY_PATH_REQUIRED", "name is required")
			return
		}
		if strings.Contains(newName, "..") || strings.Contains(newName, "/") {
			RespondCoded(c, http.StatusBadRequest, "LIBRARY_INVALID_PATH", "Invalid name")
			return
		}
		parentDir := filepath.Dir(path)
		if parentDir == "." {
			newPath = newName
		} else {
			newPath = parentDir + "/" + newName
		}
	case body.Parent != nil:
		parent := *body.Parent
		if strings.Contains(parent, "..") {
			RespondCoded(c, http.StatusBadRequest, "LIBRARY_INVALID_PATH", "Invalid parent")
			return
		}
		fileName := filepath.Base(path)
		if parent == "" {
			newPath = fileName
		} else {
			newPath = parent + "/" + fileName
		}
	default:
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_INVALID_PATCH",
			"Body must include 'name' (rename) or 'parent' (move)")
		return
	}

	newFullPath := filepath.Join(cfg.UserDataDir, newPath)
	if _, err := os.Stat(newFullPath); err == nil {
		RespondCoded(c, http.StatusConflict, "LIBRARY_FILE_CONFLICT", "A file with this name already exists")
		return
	}

	if err := h.server.FS().RenameOrMove(c.Request.Context(), path, newPath); err != nil {
		log.Error().Err(err).Str("path", path).Str("newPath", newPath).Msg("failed to rename/move file")
		RespondCoded(c, http.StatusInternalServerError, "LIBRARY_RENAME_FAILED", "Failed to rename/move file")
		return
	}

	op := "rename"
	if body.Parent != nil {
		op = "move"
	}
	h.server.Notifications().NotifyLibraryChanged(newPath, op)
	c.JSON(http.StatusOK, gin.H{"newPath": newPath})
}

// =============================================================================
// /api/data/folders
// =============================================================================

// CreateDataFolder handles POST /api/data/folders.
// Body: {"parent": "optional/parent", "name": "new-folder"}
// Mirror of CreateLibraryFolder (which used body {path, name}).
func (h *Handlers) CreateDataFolder(c *gin.Context) {
	var body struct {
		Parent string `json:"parent"`
		Name   string `json:"name"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if body.Name == "" {
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_PATH_REQUIRED", "Folder name is required")
		return
	}
	if strings.Contains(body.Parent, "..") || strings.Contains(body.Name, "..") || strings.Contains(body.Name, "/") {
		RespondCoded(c, http.StatusBadRequest, "LIBRARY_INVALID_PATH", "Invalid path or name")
		return
	}

	var folderPath string
	if body.Parent == "" {
		folderPath = body.Name
	} else {
		folderPath = body.Parent + "/" + body.Name
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.UserDataDir, folderPath)
	if _, err := os.Stat(fullPath); err == nil {
		RespondCoded(c, http.StatusConflict, "LIBRARY_FOLDER_CONFLICT", "A folder with this name already exists")
		return
	}

	if err := h.server.FS().CreateFolder(c.Request.Context(), folderPath); err != nil {
		log.Error().Err(err).Str("path", folderPath).Msg("failed to create folder")
		RespondCoded(c, http.StatusInternalServerError, "LIBRARY_CREATE_FOLDER_FAILED", "Failed to create folder")
		return
	}

	h.server.Notifications().NotifyLibraryChanged(folderPath, "create")
	c.JSON(http.StatusOK, gin.H{"path": folderPath})
}

// =============================================================================
// /api/data/pins/*path
// =============================================================================

// PutDataPin handles PUT /api/data/pins/*path — idempotent pin add.
// Replaces the toggle behaviour of the old POST /api/library/pin.
func (h *Handlers) PutDataPin(c *gin.Context) {
	path := trimPathParam(c)
	if !validateRelPath(c, path) {
		return
	}

	if err := h.server.AppDB().AddPin(c.Request.Context(), path); err != nil {
		log.Error().Err(err).Str("path", path).Msg("failed to pin file")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to pin file"})
		return
	}
	h.server.Notifications().NotifyPinChanged(path)
	c.JSON(http.StatusOK, gin.H{"isPinned": true})
}

// DeleteDataPin handles DELETE /api/data/pins/*path — idempotent pin remove.
// REST shape mirror of UnpinFile (which reads ?path=...).
func (h *Handlers) DeleteDataPin(c *gin.Context) {
	path := trimPathParam(c)
	if !validateRelPath(c, path) {
		return
	}

	if err := h.server.AppDB().RemovePin(c.Request.Context(), path); err != nil {
		log.Error().Err(err).Str("path", path).Msg("failed to unpin file")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unpin file"})
		return
	}
	h.server.Notifications().NotifyPinChanged(path)
	c.JSON(http.StatusOK, gin.H{"isPinned": false})
}
