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

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
	"github.com/xiaoyuanzhu-com/my-life-db/workers/fs"
)

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
func GetInbox(c *gin.Context) {
	limitStr := c.Query("limit")
	before := c.Query("before")
	after := c.Query("after")
	around := c.Query("around")

	limit := 30
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	var result *db.FileListResult
	var aroundResult *db.FileListAroundResult
	var targetIndex *int
	var err error

	if around != "" {
		cursor := db.ParseCursor(around)
		if cursor == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid around cursor format"})
			return
		}
		// For around queries, get items centered around the cursor (pin navigation)
		aroundResult, err = db.ListTopLevelFilesAround("inbox/", cursor, limit)
		if err == nil {
			// Convert aroundResult to regular FileListResult
			result = &db.FileListResult{
				Items: aroundResult.Items,
				HasMore: struct {
					Older bool
					Newer bool
				}{
					Older: aroundResult.HasMore.Older,
					Newer: aroundResult.HasMore.Newer,
				},
			}
			targetIndex = &aroundResult.TargetIndex
		}
	} else if before != "" {
		cursor := db.ParseCursor(before)
		if cursor == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid before cursor format"})
			return
		}
		result, err = db.ListTopLevelFilesBefore("inbox/", cursor, limit)
	} else if after != "" {
		cursor := db.ParseCursor(after)
		if cursor == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid after cursor format"})
			return
		}
		result, err = db.ListTopLevelFilesAfter("inbox/", cursor, limit)
	} else {
		result, err = db.ListTopLevelFilesNewest("inbox/", limit)
	}

	if err != nil {
		log.Error().Err(err).Msg("list inbox items failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list inbox items"})
		return
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
		TargetIndex: targetIndex,
	}

	if len(items) > 0 {
		first := db.CreateCursor(&result.Items[0])
		last := db.CreateCursor(&result.Items[len(result.Items)-1])
		response.Cursors.First = &first
		response.Cursors.Last = &last
	}

	c.JSON(http.StatusOK, response)
}

// CreateInboxItem handles POST /api/inbox
func CreateInboxItem(c *gin.Context) {
	text := c.PostForm("text")

	form, err := c.MultipartForm()
	if err != nil && err != http.ErrNotMultipart {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid form data"})
		return
	}

	var files []*multipart.FileHeader
	if form != nil {
		files = form.File["files"]
	}

	if text == "" && len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Either text or files must be provided"})
		return
	}

	cfg := config.Get()
	inboxDir := filepath.Join(cfg.DataDir, "inbox")

	// Ensure inbox directory exists
	if err := os.MkdirAll(inboxDir, 0755); err != nil {
		log.Error().Err(err).Msg("failed to create inbox directory")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create inbox directory"})
		return
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
			log.Error().Err(err).Msg("failed to save text file")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save text"})
			return
		}

		info, _ := os.Stat(fullPath)
		size := info.Size()
		mimeType := "text/markdown"

		// Create file record
		if _, err := db.UpsertFile(&db.FileRecord{
			Path:          textPath,
			Name:          textID + ".md",
			IsFolder:      false,
			Size:          &size,
			MimeType:      &mimeType,
			ModifiedAt:    nowStr,
			CreatedAt:     nowStr,
			LastScannedAt: nowStr,
		}); err != nil {
			log.Error().Err(err).Msg("failed to upsert file record")
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
		if _, err := db.UpsertFile(&db.FileRecord{
			Path:          filePath,
			Name:          filename,
			IsFolder:      false,
			Size:          &size,
			MimeType:      &mimeType,
			ModifiedAt:    nowStr,
			CreatedAt:     nowStr,
			LastScannedAt: nowStr,
		}); err != nil {
			log.Error().Err(err).Msg("failed to upsert file record")
		}

		savedPaths = append(savedPaths, filePath)
	}

	if len(savedPaths) == 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save any files"})
		return
	}

	log.Info().
		Strs("paths", savedPaths).
		Int("fileCount", len(savedPaths)).
		Msg("created inbox items")

	// Process files for metadata (hash + text preview) in background
	fsWorker := fs.GetWorker()
	if fsWorker != nil {
		go func() {
			for _, path := range savedPaths {
				fsWorker.ProcessFile(path)
			}
		}()
	}

	// Notify UI of inbox change
	notifications.GetService().NotifyInboxChanged()

	c.JSON(http.StatusCreated, gin.H{
		"path":  savedPaths[0],
		"paths": savedPaths,
	})
}

// GetInboxItem handles GET /api/inbox/:id
func GetInboxItem(c *gin.Context) {
	id := c.Param("id")

	// Try different path formats
	var file *db.FileWithDigests
	var err error

	// Try as direct inbox path
	path := "inbox/" + id
	file, err = db.GetFileWithDigests(path)
	if err != nil {
		log.Error().Err(err).Str("path", path).Msg("failed to get inbox item")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get inbox item"})
		return
	}

	if file == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Inbox item not found"})
		return
	}

	c.JSON(http.StatusOK, file)
}

// UpdateInboxItem handles PUT /api/inbox/:id
func UpdateInboxItem(c *gin.Context) {
	id := c.Param("id")
	path := "inbox/" + id

	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, path)

	// Check if file exists
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Inbox item not found"})
		return
	}

	// Get new content from request body
	var body struct {
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	// Write content to file
	if err := os.WriteFile(fullPath, []byte(body.Content), 0644); err != nil {
		log.Error().Err(err).Msg("failed to update file")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update file"})
		return
	}

	// Update file record
	nowStr := db.NowUTC()
	db.UpdateFileField(path, "modified_at", nowStr)

	c.JSON(http.StatusOK, gin.H{"success": "true"})
}

// DeleteInboxItem handles DELETE /api/inbox/:id
func DeleteInboxItem(c *gin.Context) {
	id := c.Param("id")
	path := "inbox/" + id

	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, path)

	// Check if file/folder exists
	info, err := os.Stat(fullPath)
	if os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Inbox item not found"})
		return
	}

	// Delete file/folder
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

	// Delete from database
	db.DeleteFile(path)
	db.DeleteDigestsForFile(path)
	db.RemovePin(path)

	// Notify UI
	notifications.GetService().NotifyInboxChanged()

	c.JSON(http.StatusOK, gin.H{"success": "true"})
}

// PinnedItem represents a pinned item for UI display (matching Node.js schema)
type PinnedItem struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	PinnedAt    string `json:"pinnedAt"`
	DisplayText string `json:"displayText"`
	Cursor      string `json:"cursor"`
}

// GetPinnedInboxItems handles GET /api/inbox/pinned
func GetPinnedInboxItems(c *gin.Context) {
	files, err := db.GetPinnedFiles()
	if err != nil {
		log.Error().Err(err).Msg("failed to get pinned files")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get pinned files"})
		return
	}

	// Filter to inbox only and transform to PinnedItem format
	items := make([]PinnedItem, 0)
	for _, f := range files {
		if strings.HasPrefix(f.Path, "inbox/") {
			// Get display text: first line of textPreview or filename
			displayText := f.Name
			if f.TextPreview != nil && *f.TextPreview != "" {
				// Get first line of text preview
				lines := strings.Split(*f.TextPreview, "\n")
				if len(lines) > 0 && strings.TrimSpace(lines[0]) != "" {
					displayText = strings.TrimSpace(lines[0])
				}
			}

			// Create cursor (format: created_at:path)
			cursor := f.CreatedAt + ":" + f.Path

			items = append(items, PinnedItem{
				Path:        f.Path,
				Name:        f.Name,
				PinnedAt:    f.CreatedAt, // Using file's created_at as pinnedAt
				DisplayText: displayText,
				Cursor:      cursor,
			})
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"items": items,
	})
}

// ReenrichInboxItem handles POST /api/inbox/:id/reenrich
func ReenrichInboxItem(c *gin.Context) {
	id := c.Param("id")
	path := "inbox/" + id

	// Check if file exists in database
	file, err := db.GetFileByPath(path)
	if err != nil || file == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Inbox item not found"})
		return
	}

	// Reset all digests for this file
	db.DeleteDigestsForFile(path)

	// TODO: Trigger digest processing

	c.JSON(http.StatusOK, gin.H{"success": "true", "message": "Re-enrichment triggered"})
}

// GetInboxItemStatus handles GET /api/inbox/:id/status
func GetInboxItemStatus(c *gin.Context) {
	id := c.Param("id")
	path := "inbox/" + id

	digests, err := db.GetDigestsForFile(path)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get status"})
		return
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

	c.JSON(http.StatusOK, gin.H{
		"status":  status,
		"digests": digests,
	})
}
