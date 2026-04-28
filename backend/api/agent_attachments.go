package api

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

const maxAttachmentSize = 1 << 30 // 1 GiB

// attachmentsHandler stages user-uploaded files for an in-flight agent session.
//
// Uploads land at:
//
//	USER_DATA_DIR/sessions/<storageID>/uploads/<filename>
//
// The storageID is the per-session storage id (see agent_storage.go). When the
// caller doesn't supply one (very first upload before any session exists), we
// mint a fresh id and return it; the client persists it and includes it on
// subsequent uploads + on POST /api/agent/sessions.
type attachmentsHandler struct {
	userDataDir string
}

// UploadAttachment handles POST /api/agent/attachments.
//
//	form fields: file (required), storageId (optional)
//	response:    { storageId, filename, absolutePath, size, contentType }
func (a *attachmentsHandler) UploadAttachment(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAttachmentSize)

	fileHeader, err := c.FormFile("file")
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "file exceeds 1 GiB limit"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing or invalid 'file' field: " + err.Error()})
		return
	}
	if fileHeader.Size > maxAttachmentSize {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "file exceeds 1 GiB limit"})
		return
	}

	storageID := c.PostForm("storageId")
	if storageID == "" {
		storageID = mintStorageID()
	} else if !validStorageID(storageID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid storageId"})
		return
	}

	filename := filepath.Base(fileHeader.Filename)
	if filename == "" || filename == "." || filename == string(filepath.Separator) {
		filename = "file"
	}

	destDir := sessionUploadsDir(a.userDataDir, storageID)
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		log.Error().Err(err).Str("dir", destDir).Msg("agent-attachments: mkdir failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create staging dir"})
		return
	}

	finalName := uniqueFilename(destDir, filename)
	destPath := filepath.Join(destDir, finalName)

	src, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to open upload: " + err.Error()})
		return
	}
	defer src.Close()

	dst, err := os.Create(destPath)
	if err != nil {
		log.Error().Err(err).Str("path", destPath).Msg("agent-attachments: create failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to stage file"})
		return
	}
	written, err := io.Copy(dst, src)
	closeErr := dst.Close()
	if err != nil || closeErr != nil {
		os.Remove(destPath)
		log.Error().Err(err).AnErr("closeErr", closeErr).Str("path", destPath).Msg("agent-attachments: write failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write file"})
		return
	}

	log.Info().
		Str("storageID", storageID).
		Str("filename", finalName).
		Int64("size", written).
		Msg("agent-attachments: upload staged")

	c.JSON(http.StatusOK, gin.H{
		"storageId":    storageID,
		"filename":     finalName,
		"absolutePath": destPath,
		"size":         written,
		"contentType":  fileHeader.Header.Get("Content-Type"),
	})
}

// UploadAgentAttachment is the production shim used by the real router.
func (h *Handlers) UploadAgentAttachment(c *gin.Context) {
	inner := &attachmentsHandler{userDataDir: h.server.Cfg().UserDataDir}
	inner.UploadAttachment(c)
}

// DeleteAttachment handles DELETE /api/agent/attachments/:storageId/:filename.
// Removes one staged file. Idempotent — returns 204 whether or not the file
// existed. Rejects path-traversal attempts in either parameter.
func (a *attachmentsHandler) DeleteAttachment(c *gin.Context) {
	storageID := c.Param("storageId")
	filename := c.Param("filename")
	if !validStorageID(storageID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid storageId"})
		return
	}
	if filename == "" || filename != filepath.Base(filename) || filename == "." || filename == ".." {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid filename"})
		return
	}

	full := filepath.Join(sessionUploadsDir(a.userDataDir, storageID), filename)
	if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
		log.Error().Err(err).Str("path", full).Msg("agent-attachments: delete failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete"})
		return
	}
	log.Info().Str("storageID", storageID).Str("filename", filename).Msg("agent-attachments: upload deleted")
	c.Status(http.StatusNoContent)
	// WriteHeaderNow flushes the status immediately. Without this, gin's lazy
	// header writing leaves httptest.ResponseRecorder.Code at 200 in unit tests.
	c.Writer.WriteHeaderNow()
}

func (h *Handlers) DeleteAgentAttachment(c *gin.Context) {
	inner := &attachmentsHandler{userDataDir: h.server.Cfg().UserDataDir}
	inner.DeleteAttachment(c)
}
