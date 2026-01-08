package api

import (
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

var inboxLogger = log.GetLogger("ApiInbox")

// InboxItem represents an inbox item in API responses
type InboxItem struct {
	Path            string      `json:"path"`
	Name            string      `json:"name"`
	IsFolder        bool        `json:"isFolder"`
	Size            *int64      `json:"size,omitempty"`
	MimeType        *string     `json:"mimeType,omitempty"`
	Hash            *string     `json:"hash,omitempty"`
	ModifiedAt      string      `json:"modifiedAt"`
	CreatedAt       string      `json:"createdAt"`
	Digests         []db.Digest `json:"digests"`
	TextPreview     *string     `json:"textPreview,omitempty"`
	ScreenshotSqlar *string     `json:"screenshotSqlar,omitempty"`
	IsPinned        bool        `json:"isPinned"`
}

// InboxResponse represents the inbox list response
type InboxResponse struct {
	Items   []InboxItem `json:"items"`
	Cursors struct {
		First *string `json:"first"`
		Last  *string `json:"last"`
	} `json:"cursors"`
	HasMore struct {
		Older bool `json:"older"`
		Newer bool `json:"newer"`
	} `json:"hasMore"`
	TargetIndex *int `json:"targetIndex,omitempty"`
}

// GetInbox handles GET /api/inbox
func GetInbox(c echo.Context) error {
	limitStr := c.QueryParam("limit")
	before := c.QueryParam("before")
	after := c.QueryParam("after")
	around := c.QueryParam("around")

	limit := 30
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	var result *db.FileListResult
	var err error

	if around != "" {
		cursor := db.ParseCursor(around)
		if cursor == nil {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid around cursor format"})
		}
		// For around queries, get items before and after
		result, err = db.ListTopLevelFilesNewest("inbox/", limit)
	} else if before != "" {
		cursor := db.ParseCursor(before)
		if cursor == nil {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid before cursor format"})
		}
		result, err = db.ListTopLevelFilesBefore("inbox/", cursor, limit)
	} else if after != "" {
		cursor := db.ParseCursor(after)
		if cursor == nil {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid after cursor format"})
		}
		result, err = db.ListTopLevelFilesAfter("inbox/", cursor, limit)
	} else {
		result, err = db.ListTopLevelFilesNewest("inbox/", limit)
	}

	if err != nil {
		inboxLogger.Error().Err(err).Msg("list inbox items failed")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to list inbox items"})
	}

	// Convert to InboxItems
	items := make([]InboxItem, 0, len(result.Items))
	for _, f := range result.Items {
		isPinned, _ := db.IsPinned(f.Path)
		items = append(items, InboxItem{
			Path:            f.Path,
			Name:            f.Name,
			IsFolder:        f.IsFolder,
			Size:            f.Size,
			MimeType:        f.MimeType,
			Hash:            f.Hash,
			ModifiedAt:      f.ModifiedAt,
			CreatedAt:       f.CreatedAt,
			Digests:         []db.Digest{},
			TextPreview:     f.TextPreview,
			ScreenshotSqlar: f.ScreenshotSqlar,
			IsPinned:        isPinned,
		})
	}

	// Build response
	response := InboxResponse{
		Items: items,
		HasMore: struct {
			Older bool `json:"older"`
			Newer bool `json:"newer"`
		}{
			Older: result.HasMore.Older,
			Newer: result.HasMore.Newer,
		},
	}

	if len(items) > 0 {
		first := db.CreateCursor(&result.Items[0])
		last := db.CreateCursor(&result.Items[len(result.Items)-1])
		response.Cursors.First = &first
		response.Cursors.Last = &last
	}

	return c.JSON(http.StatusOK, response)
}

// CreateInboxItem handles POST /api/inbox
func CreateInboxItem(c echo.Context) error {
	text := c.FormValue("text")

	form, err := c.MultipartForm()
	if err != nil && err != http.ErrNotMultipart {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid form data"})
	}

	var files []*multipart.FileHeader
	if form != nil {
		files = form.File["files"]
	}

	if text == "" && len(files) == 0 {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Either text or files must be provided"})
	}

	cfg := config.Get()
	inboxDir := filepath.Join(cfg.DataDir, "inbox")

	// Ensure inbox directory exists
	if err := os.MkdirAll(inboxDir, 0755); err != nil {
		inboxLogger.Error().Err(err).Msg("failed to create inbox directory")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to create inbox directory"})
	}

	var savedPaths []string
	now := time.Now().UTC()
	nowStr := now.Format(time.RFC3339)

	// Save text file if provided
	if text != "" {
		textID := uuid.New().String()
		textPath := filepath.Join("inbox", textID+".md")
		fullPath := filepath.Join(cfg.DataDir, textPath)

		if err := os.WriteFile(fullPath, []byte(text), 0644); err != nil {
			inboxLogger.Error().Err(err).Msg("failed to save text file")
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to save text"})
		}

		info, _ := os.Stat(fullPath)
		size := info.Size()
		mimeType := "text/markdown"

		// Create file record
		if err := db.UpsertFile(&db.FileRecord{
			Path:          textPath,
			Name:          textID + ".md",
			IsFolder:      false,
			Size:          &size,
			MimeType:      &mimeType,
			ModifiedAt:    nowStr,
			CreatedAt:     nowStr,
			LastScannedAt: nowStr,
		}); err != nil {
			inboxLogger.Error().Err(err).Msg("failed to create file record")
		}

		savedPaths = append(savedPaths, textPath)
	}

	// Save uploaded files
	for _, fileHeader := range files {
		filename := utils.SanitizeFilename(fileHeader.Filename)
		filename = utils.DeduplicateFilename(inboxDir, filename)

		filePath := filepath.Join("inbox", filename)
		fullPath := filepath.Join(cfg.DataDir, filePath)

		src, err := fileHeader.Open()
		if err != nil {
			continue
		}

		dst, err := os.Create(fullPath)
		if err != nil {
			src.Close()
			continue
		}

		_, err = io.Copy(dst, src)
		src.Close()
		dst.Close()

		if err != nil {
			continue
		}

		info, _ := os.Stat(fullPath)
		size := info.Size()
		mimeType := utils.DetectMimeType(filename)

		// Create file record
		if err := db.UpsertFile(&db.FileRecord{
			Path:          filePath,
			Name:          filename,
			IsFolder:      false,
			Size:          &size,
			MimeType:      &mimeType,
			ModifiedAt:    nowStr,
			CreatedAt:     nowStr,
			LastScannedAt: nowStr,
		}); err != nil {
			inboxLogger.Error().Err(err).Msg("failed to create file record")
		}

		savedPaths = append(savedPaths, filePath)
	}

	if len(savedPaths) == 0 {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to save any files"})
	}

	inboxLogger.Info().
		Strs("paths", savedPaths).
		Int("fileCount", len(savedPaths)).
		Msg("created inbox items")

	// Notify UI of inbox change
	notifications.GetService().NotifyInboxChanged()

	// TODO: Trigger digest processing for each file

	return c.JSON(http.StatusCreated, map[string]interface{}{
		"path":  savedPaths[0],
		"paths": savedPaths,
	})
}

// GetInboxItem handles GET /api/inbox/:id
func GetInboxItem(c echo.Context) error {
	id := c.Param("id")

	// Try different path formats
	var file *db.FileWithDigests
	var err error

	// Try as direct inbox path
	path := "inbox/" + id
	file, err = db.GetFileWithDigests(path)
	if err != nil {
		inboxLogger.Error().Err(err).Str("path", path).Msg("failed to get inbox item")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to get inbox item"})
	}

	if file == nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "Inbox item not found"})
	}

	return c.JSON(http.StatusOK, file)
}

// UpdateInboxItem handles PUT /api/inbox/:id
func UpdateInboxItem(c echo.Context) error {
	id := c.Param("id")
	path := "inbox/" + id

	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, path)

	// Check if file exists
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "Inbox item not found"})
	}

	// Get new content from request body
	var body struct {
		Content string `json:"content"`
	}
	if err := c.Bind(&body); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
	}

	// Write content to file
	if err := os.WriteFile(fullPath, []byte(body.Content), 0644); err != nil {
		inboxLogger.Error().Err(err).Msg("failed to update file")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to update file"})
	}

	// Update file record
	nowStr := db.NowUTC()
	db.UpdateFileField(path, "modified_at", nowStr)

	return c.JSON(http.StatusOK, map[string]string{"success": "true"})
}

// DeleteInboxItem handles DELETE /api/inbox/:id
func DeleteInboxItem(c echo.Context) error {
	id := c.Param("id")
	path := "inbox/" + id

	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, path)

	// Check if file/folder exists
	info, err := os.Stat(fullPath)
	if os.IsNotExist(err) {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "Inbox item not found"})
	}

	// Delete file/folder
	if info.IsDir() {
		if err := os.RemoveAll(fullPath); err != nil {
			inboxLogger.Error().Err(err).Msg("failed to delete folder")
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to delete folder"})
		}
	} else {
		if err := os.Remove(fullPath); err != nil {
			inboxLogger.Error().Err(err).Msg("failed to delete file")
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to delete file"})
		}
	}

	// Delete from database
	db.DeleteFile(path)
	db.DeleteDigestsForFile(path)
	db.RemovePin(path)

	// Notify UI
	notifications.GetService().NotifyInboxChanged()

	return c.JSON(http.StatusOK, map[string]string{"success": "true"})
}

// GetPinnedInboxItems handles GET /api/inbox/pinned
func GetPinnedInboxItems(c echo.Context) error {
	files, err := db.GetPinnedFiles()
	if err != nil {
		inboxLogger.Error().Err(err).Msg("failed to get pinned files")
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to get pinned files"})
	}

	// Filter to inbox only
	var inboxFiles []db.FileWithDigests
	for _, f := range files {
		if strings.HasPrefix(f.Path, "inbox/") {
			inboxFiles = append(inboxFiles, f)
		}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"items": inboxFiles,
	})
}

// ReenrichInboxItem handles POST /api/inbox/:id/reenrich
func ReenrichInboxItem(c echo.Context) error {
	id := c.Param("id")
	path := "inbox/" + id

	// Check if file exists in database
	file, err := db.GetFileByPath(path)
	if err != nil || file == nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "Inbox item not found"})
	}

	// Reset all digests for this file
	db.DeleteDigestsForFile(path)

	// TODO: Trigger digest processing

	return c.JSON(http.StatusOK, map[string]string{"success": "true", "message": "Re-enrichment triggered"})
}

// GetInboxItemStatus handles GET /api/inbox/:id/status
func GetInboxItemStatus(c echo.Context) error {
	id := c.Param("id")
	path := "inbox/" + id

	digests, err := db.GetDigestsForFile(path)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to get status"})
	}

	// Calculate overall status
	status := "done"
	for _, d := range digests {
		if d.Status == "running" {
			status = "processing"
			break
		}
		if d.Status == "todo" || d.Status == "failed" {
			status = "pending"
		}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"status":  status,
		"digests": digests,
	})
}

