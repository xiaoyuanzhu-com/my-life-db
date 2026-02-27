package fs

import (
	"bytes"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	"github.com/gen2brain/heic"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"golang.org/x/image/draw"

	// Register WebP decoder so image.Decode can handle it
	_ "golang.org/x/image/webp"
)

// Preview worker constants
const (
	previewQueueSize  = 100
	thumbnailMaxWidth = 400
	thumbnailQuality  = 80
)

// previewJob represents a file that needs preview generation
type previewJob struct {
	filePath string
	mimeType string
}

// PreviewNotifier is called after a preview is generated for a file.
// filePath is the relative file path, previewType is "thumbnail" or "screenshot".
type PreviewNotifier func(filePath string, previewType string)

// previewWorker processes files asynchronously to generate previews
type previewWorker struct {
	service  *Service
	queue    chan previewJob
	notifier PreviewNotifier
}

// ---------- MIME type helpers ----------

// needsImagePreview returns true for MIME types that support preview generation
func needsImagePreview(mimeType string) bool {
	return isImageMime(mimeType) || isVideoMime(mimeType) || isDocumentMime(mimeType)
}

// isImageMime returns true for image/* MIME types
func isImageMime(mimeType string) bool {
	return strings.HasPrefix(mimeType, "image/")
}

// isVideoMime returns true for video/* MIME types
func isVideoMime(mimeType string) bool {
	return strings.HasPrefix(mimeType, "video/")
}

// isDocumentMime returns true for document MIME types that support screenshot preview
func isDocumentMime(mimeType string) bool {
	switch mimeType {
	case "application/pdf",
		"application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.ms-powerpoint",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		return true
	}
	return false
}

// ---------- Worker lifecycle ----------

// newPreviewWorker creates a preview worker owned by the given service
func newPreviewWorker(service *Service, notifier PreviewNotifier) *previewWorker {
	return &previewWorker{
		service:  service,
		queue:    make(chan previewJob, previewQueueSize),
		notifier: notifier,
	}
}

// run reads jobs from the queue until the channel is closed.
// Intended to be called as a goroutine.
func (w *previewWorker) run() {
	for job := range w.queue {
		w.processJob(job)
	}
}

// enqueue sends a preview job to the worker. Non-blocking: if the queue is
// full the job is dropped and a warning is logged.
func (w *previewWorker) enqueue(job previewJob) {
	select {
	case w.queue <- job:
		// queued
	default:
		log.Warn().
			Str("path", job.filePath).
			Str("mime", job.mimeType).
			Msg("preview queue full, job dropped")
	}
}

// ---------- Preview generation dispatch ----------

// processJob dispatches to the correct generator based on MIME type,
// stores the result in SQLAR, and updates the file record.
func (w *previewWorker) processJob(job previewJob) {
	var data []byte
	var err error
	var previewType string
	var sqlarName string

	pathHash := db.GeneratePathHash(job.filePath)

	switch {
	case isImageMime(job.mimeType):
		previewType = "thumbnail"
		sqlarName = pathHash + "/preview/thumbnail.jpg"
		data, err = w.generateImageThumbnail(job.filePath, job.mimeType)

	case isDocumentMime(job.mimeType):
		previewType = "screenshot"
		sqlarName = pathHash + "/preview/screenshot.png"
		data, err = w.generateDocScreenshot(job.filePath)

	case isVideoMime(job.mimeType):
		previewType = "thumbnail"
		sqlarName = pathHash + "/preview/thumbnail.jpg"
		data, err = w.generateVideoThumbnail(job.filePath)

	default:
		return
	}

	if err != nil {
		log.Error().Err(err).
			Str("path", job.filePath).
			Str("mime", job.mimeType).
			Msg("preview generation failed")
		return
	}

	// Placeholder generators return nil, nil — nothing to store yet
	if data == nil {
		return
	}

	// Store in SQLAR
	ok := w.service.cfg.DB.SqlarStore(sqlarName, data, 0644)
	if !ok {
		log.Error().
			Str("path", job.filePath).
			Str("sqlar", sqlarName).
			Msg("failed to store preview in sqlar")
		return
	}

	// Update file record with the SQLAR path
	if err := w.service.cfg.DB.UpdateFileField(job.filePath, "preview_sqlar", sqlarName); err != nil {
		log.Error().Err(err).
			Str("path", job.filePath).
			Msg("failed to update preview_sqlar field")
		return
	}

	log.Info().
		Str("path", job.filePath).
		Str("sqlar", sqlarName).
		Int("bytes", len(data)).
		Msg("preview generated")

	// Notify listener (e.g. SSE push) if set
	if w.notifier != nil {
		w.notifier(job.filePath, previewType)
	}
}

// ---------- Image thumbnail ----------

// generateImageThumbnail decodes an image file, resizes it to thumbnailMaxWidth,
// and encodes the result as JPEG.
func (w *previewWorker) generateImageThumbnail(filePath, mimeType string) ([]byte, error) {
	fullPath := filepath.Join(w.service.cfg.DataRoot, filePath)

	f, err := os.Open(fullPath)
	if err != nil {
		return nil, fmt.Errorf("open image: %w", err)
	}
	defer f.Close()

	var img image.Image

	// HEIC/HEIF needs a dedicated decoder (not registered with image.Decode)
	if mimeType == "image/heic" || mimeType == "image/heif" {
		img, err = heic.Decode(f)
		if err != nil {
			return nil, fmt.Errorf("decode heic: %w", err)
		}
	} else {
		// For JPEG, PNG, GIF, WebP and anything else with a registered decoder.
		// GIF decodes to the first frame automatically via image.Decode.
		img, _, err = image.Decode(f)
		if err != nil {
			return nil, fmt.Errorf("decode image (%s): %w", mimeType, err)
		}
	}

	// Resize
	thumb := resizeToMaxWidth(img, thumbnailMaxWidth)

	// Encode as JPEG
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: thumbnailQuality}); err != nil {
		return nil, fmt.Errorf("encode jpeg thumbnail: %w", err)
	}

	return buf.Bytes(), nil
}

// resizeToMaxWidth scales an image so its width is at most maxWidth pixels,
// preserving aspect ratio. If the image is already smaller it is returned as-is.
func resizeToMaxWidth(src image.Image, maxWidth int) image.Image {
	bounds := src.Bounds()
	srcW := bounds.Dx()
	srcH := bounds.Dy()

	if srcW <= maxWidth {
		return src
	}

	// Compute new dimensions preserving aspect ratio
	newW := maxWidth
	newH := srcH * maxWidth / srcW

	dst := image.NewRGBA(image.Rect(0, 0, newW, newH))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, bounds, draw.Over, nil)
	return dst
}

// ---------- Placeholder generators ----------

// generateDocScreenshot is a placeholder for document screenshot generation.
// Will be implemented in a future task.
func (w *previewWorker) generateDocScreenshot(filePath string) ([]byte, error) {
	return nil, nil
}

// generateVideoThumbnail is a placeholder for video thumbnail generation.
// Will be implemented in a future task.
func (w *previewWorker) generateVideoThumbnail(filePath string) ([]byte, error) {
	return nil, nil
}

// Ensure standard image decoders are registered (JPEG, PNG, GIF are auto-registered
// by their packages when imported). We import them above for encoding as well, which
// also triggers registration. WebP is registered via the blank import of
// golang.org/x/image/webp.
//
// The init guard below silences "imported and not used" for the standard decoders
// whose Decode functions we never call directly (we rely on image.Decode).
var (
	_ = png.Decode
	_ = gif.Decode
)
