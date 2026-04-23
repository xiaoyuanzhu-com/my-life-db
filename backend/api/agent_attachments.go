package api

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// maxAttachmentSize is the per-file upload cap (1 GiB).
// Enforced via http.MaxBytesReader so oversized requests get 413 cheaply
// before we try to parse them.
const maxAttachmentSize = 1 << 30

// attachmentsHandler owns the on-disk staging area for agent attachments.
// It's a small inner helper so its logic can be unit-tested without wiring
// the full Server. Production usage goes through the Handlers shim below.
type attachmentsHandler struct {
	appDataDir string
}

// UploadAttachment handles POST /api/agent/attachments.
// Stages a single multipart file at APP_DATA_DIR/tmp/agent-uploads/<uuid>/<filename>
// and returns the absolute path + metadata.
func (a *attachmentsHandler) UploadAttachment(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAttachmentSize)

	fileHeader, err := c.FormFile("file")
	if err != nil {
		// MaxBytesReader tripping mid-parse surfaces here — surface it as 413
		// instead of a generic 400 so the client can distinguish "too big" from
		// "bad request".
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

	// Sanitize filename — strip any path components the client provided.
	filename := filepath.Base(fileHeader.Filename)
	if filename == "" || filename == "." || filename == string(filepath.Separator) {
		filename = "file"
	}

	uploadID := uuid.New().String()
	destDir := filepath.Join(a.appDataDir, "tmp", "agent-uploads", uploadID)
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		log.Error().Err(err).Str("dir", destDir).Msg("agent-attachments: mkdir failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create staging dir"})
		return
	}
	destPath := filepath.Join(destDir, filename)

	src, err := fileHeader.Open()
	if err != nil {
		os.RemoveAll(destDir)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to open upload: " + err.Error()})
		return
	}
	defer src.Close()

	dst, err := os.Create(destPath)
	if err != nil {
		os.RemoveAll(destDir)
		log.Error().Err(err).Str("path", destPath).Msg("agent-attachments: create failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to stage file"})
		return
	}
	written, err := io.Copy(dst, src)
	closeErr := dst.Close()
	if err != nil || closeErr != nil {
		os.RemoveAll(destDir)
		log.Error().Err(err).Err(closeErr).Str("path", destPath).Msg("agent-attachments: write failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write file"})
		return
	}

	log.Info().
		Str("uploadID", uploadID).
		Str("filename", filename).
		Int64("size", written).
		Msg("agent-attachments: upload staged")

	c.JSON(http.StatusOK, gin.H{
		"uploadID":     uploadID,
		"absolutePath": destPath,
		"filename":     filename,
		"size":         written,
		"contentType":  fileHeader.Header.Get("Content-Type"),
	})
}

// UploadAgentAttachment is the production shim used by the real router.
// Delegates to the inner handler with the server-configured app data dir.
func (h *Handlers) UploadAgentAttachment(c *gin.Context) {
	inner := &attachmentsHandler{appDataDir: h.server.Cfg().AppDataDir}
	inner.UploadAttachment(c)
}

// DeleteAttachment handles DELETE /api/agent/attachments/:uploadID.
// Removes the staged directory. Idempotent — returns 204 whether or not
// the dir existed. Rejects uploadIDs that contain path separators.
func (a *attachmentsHandler) DeleteAttachment(c *gin.Context) {
	uploadID := c.Param("uploadID")
	if uploadID == "" || uploadID == "." || uploadID == ".." ||
		filepath.Base(uploadID) != uploadID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid uploadID"})
		return
	}

	dir := filepath.Join(a.appDataDir, "tmp", "agent-uploads", uploadID)
	if err := os.RemoveAll(dir); err != nil {
		log.Error().Err(err).Str("uploadID", uploadID).Msg("agent-attachments: delete failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete"})
		return
	}

	log.Info().Str("uploadID", uploadID).Msg("agent-attachments: upload deleted")
	c.Status(http.StatusNoContent)
}

// DeleteAgentAttachment is the production shim used by the real router.
func (h *Handlers) DeleteAgentAttachment(c *gin.Context) {
	inner := &attachmentsHandler{appDataDir: h.server.Cfg().AppDataDir}
	inner.DeleteAttachment(c)
}
