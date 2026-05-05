# Unified File Preview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make file previews a core feature of the `fs` package — every file gets one preview (text or image), independent of the digest pipeline.

**Architecture:** A new `fs/preview.go` owns async image preview generation (thumbnails for images, screenshots for docs, video frames). The existing `text_preview` stays as-is (sync on ingest). A schema rename changes `screenshot_sqlar` → `preview_sqlar` throughout. Two digesters (`DocToScreenshotDigester`, `ImagePreviewDigester`) are removed; the preview worker replaces them.

**Tech Stack:** Go stdlib `image/*`, `golang.org/x/image/draw` for resizing, `gen2brain/heic` (already in go.mod), `vendors.GetHAID()` for doc screenshots, `ffmpeg` for video frames, SQLite SQLAR for storage.

---

### Task 1: Rename `screenshot_sqlar` → `preview_sqlar` everywhere

This is the foundational rename. Every backend and frontend reference to `screenshot_sqlar` / `screenshotSqlar` / `ScreenshotSqlar` must become `preview_sqlar` / `previewSqlar` / `PreviewSqlar`. Must be atomic — all references change together.

**Files:**
- Create: `backend/db/migration_011_preview_sqlar.go`
- Modify: `backend/db/models.go:20` — struct field rename
- Modify: `backend/db/models.go:134` — scanFileRecord
- Modify: `backend/db/files.go` — all SQL queries + Go vars (lines 18, 28, 34, 48, 62-63, 72, 80-83, 159-160, 166-170, 186-187, 259, 278, 284, 295, 313-314, 339-340, 353, 371-372, 396-397, 410, 447, 467, 470-471, 484, 520, 530, 783, 816-817, 823-829)
- Modify: `backend/db/pins.go:64,82,88,99` — GetPinnedFiles
- Modify: `backend/api/inbox.go:32` — InboxItem.ScreenshotSqlar
- Modify: `backend/api/search.go:41,213` — SearchResult.ScreenshotSqlar
- Modify: `backend/workers/digest/worker.go:504` — UpdateFileField call
- Modify: `backend/db/migration_001_initial.go:60` — initial schema comment (informational)
- Modify: `frontend/app/types/file-record.ts:45,85,103` — TS type + rowToFileRecord
- Modify: `frontend/app/types/file-card.ts:40` — FileWithDigests
- Modify: `frontend/app/types/api.ts:29,87` — InboxItem + SearchResult
- Modify: `frontend/app/components/FileCard/utils.ts:373-375,404` — getImageUrl + getScreenshotUrl

**Step 1: Create the migration file**

```go
// backend/db/migration_011_preview_sqlar.go
package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     11,
		Description: "Rename screenshot_sqlar to preview_sqlar",
		Up:          migration011_previewSqlar,
	})
}

func migration011_previewSqlar(db *sql.DB) error {
	_, err := db.Exec(`ALTER TABLE files RENAME COLUMN screenshot_sqlar TO preview_sqlar`)
	return err
}
```

**Step 2: Rename Go struct field**

In `backend/db/models.go:20`:
```go
// Before:
ScreenshotSqlar *string   `json:"screenshotSqlar,omitempty"`
// After:
PreviewSqlar *string   `json:"previewSqlar,omitempty"`
```

**Step 3: Rename all SQL column references in backend/db/files.go**

Every `screenshot_sqlar` in SQL strings becomes `preview_sqlar`.
Every `screenshotSqlar` Go variable becomes `previewSqlar`.
Every `.ScreenshotSqlar` field access becomes `.PreviewSqlar`.

Use find-and-replace across the entire file:
- `screenshot_sqlar` → `preview_sqlar` (SQL column)
- `screenshotSqlar` → `previewSqlar` (Go variable names)
- `ScreenshotSqlar` → `PreviewSqlar` (Go struct field access)

**Step 4: Rename in backend/db/pins.go**

Same pattern: `screenshot_sqlar` → `preview_sqlar`, `.ScreenshotSqlar` → `.PreviewSqlar`.

**Step 5: Rename in backend/db/models.go scanFileRecord**

Line 134: `&f.ScreenshotSqlar` → `&f.PreviewSqlar`.

**Step 6: Rename in API structs**

In `backend/api/inbox.go`:
```go
// Before:
ScreenshotSqlar *string `json:"screenshotSqlar,omitempty"`
// After:
PreviewSqlar *string `json:"previewSqlar,omitempty"`
```

Same in `backend/api/search.go`.

**Step 7: Rename in UpdateFileField whitelist**

In `backend/db/files.go:783`:
```go
// Before:
"screenshot_sqlar": true,
// After:
"preview_sqlar": true,
```

**Step 8: Update digest worker reference**

In `backend/workers/digest/worker.go:504`:
```go
// Before:
db.UpdateFileField(filePath, "screenshot_sqlar", sqlarPath)
// After:
db.UpdateFileField(filePath, "preview_sqlar", sqlarPath)
```

**Step 9: Rename all frontend TypeScript references**

In `frontend/app/types/file-record.ts`:
- `screenshot_sqlar` → `preview_sqlar` (FileRecordRow)
- `screenshotSqlar` → `previewSqlar` (FileRecord)
- Update `rowToFileRecord` mapping

In `frontend/app/types/file-card.ts`:
- `screenshotSqlar` → `previewSqlar`

In `frontend/app/types/api.ts`:
- `screenshotSqlar` → `previewSqlar` (both InboxItem and SearchResult)

In `frontend/app/components/FileCard/utils.ts`:
- `file.screenshotSqlar` → `file.previewSqlar` (all occurrences)

**Step 10: Build and verify**

Run: `cd backend && go build ./...`
Expected: Compiles with no errors.

Run: `cd frontend && npm run build` (or `npx tsc --noEmit`)
Expected: Compiles with no TS errors.

**Step 11: Commit**

```bash
git add -A
git commit -m "refactor: rename screenshot_sqlar to preview_sqlar

Unified preview column name. Migration 011 renames the SQLite column.
All Go, SQL, and TypeScript references updated atomically."
```

---

### Task 2: Preview worker infrastructure (`fs/preview.go`)

Create the core preview worker: types, queue channel, worker goroutine, and the image thumbnail generator for common image formats.

**Files:**
- Create: `backend/fs/preview.go`
- Modify: `backend/fs/types.go:56-69` — add `SqlarStore` + `SqlarExists` to Database interface
- Modify: `backend/fs/service.go` — add preview worker fields, start/stop, queuePreview

**Step 1: Extend the Database interface**

In `backend/fs/types.go`, add to the `Database` interface (after line 67):
```go
// SQLAR operations (for preview storage)
SqlarStore(name string, data []byte, mode int) bool
SqlarExists(name string) bool
```

**Step 2: Create `backend/fs/preview.go`**

```go
package fs

import (
	"bytes"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	_ "golang.org/x/image/webp" // WebP decode support
	"golang.org/x/image/draw"

	"github.com/gen2brain/heic"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

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

// PreviewNotifier is called when a preview is ready
type PreviewNotifier func(filePath string, previewType string)

// previewWorker generates image previews for files
type previewWorker struct {
	service  *Service
	queue    chan previewJob
	notifier PreviewNotifier
}

// newPreviewWorker creates a new preview worker
func newPreviewWorker(service *Service, notifier PreviewNotifier) *previewWorker {
	return &previewWorker{
		service:  service,
		queue:    make(chan previewJob, previewQueueSize),
		notifier: notifier,
	}
}

// run processes preview jobs until the channel is closed
func (w *previewWorker) run() {
	for job := range w.queue {
		w.processJob(job)
	}
}

// enqueue adds a preview job to the queue (non-blocking)
func (w *previewWorker) enqueue(job previewJob) {
	select {
	case w.queue <- job:
		// Queued
	default:
		log.Warn().
			Str("path", job.filePath).
			Msg("preview queue full, job dropped (scanner will catch up)")
	}
}

// needsImagePreview checks if a file type should get an image preview
func needsImagePreview(mimeType string) bool {
	return isImageMime(mimeType) || isDocumentMime(mimeType) || isVideoMime(mimeType)
}

func isImageMime(mimeType string) bool {
	return strings.HasPrefix(mimeType, "image/")
}

func isDocumentMime(mimeType string) bool {
	docTypes := []string{
		"application/pdf",
		"application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.ms-powerpoint",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	}
	for _, dt := range docTypes {
		if mimeType == dt {
			return true
		}
	}
	return false
}

func isVideoMime(mimeType string) bool {
	return strings.HasPrefix(mimeType, "video/")
}

// processJob generates a preview for one file
func (w *previewWorker) processJob(job previewJob) {
	log.Debug().Str("path", job.filePath).Str("mime", job.mimeType).Msg("generating preview")

	var previewData []byte
	var previewName string
	var err error

	switch {
	case isImageMime(job.mimeType):
		previewData, err = w.generateImageThumbnail(job.filePath, job.mimeType)
		previewName = "thumbnail.jpg"
	case isDocumentMime(job.mimeType):
		previewData, err = w.generateDocScreenshot(job.filePath)
		previewName = "screenshot.png"
	case isVideoMime(job.mimeType):
		previewData, err = w.generateVideoThumbnail(job.filePath)
		previewName = "thumbnail.jpg"
	default:
		return
	}

	if err != nil {
		log.Warn().Err(err).Str("path", job.filePath).Msg("failed to generate preview")
		return
	}
	if len(previewData) == 0 {
		log.Warn().Str("path", job.filePath).Msg("preview generation produced empty data")
		return
	}

	// Store in SQLAR
	pathHash := db.GeneratePathHash(job.filePath)
	sqlarPath := pathHash + "/preview/" + previewName

	if !w.service.cfg.DB.SqlarStore(sqlarPath, previewData, 0644) {
		log.Error().Str("path", job.filePath).Msg("failed to store preview in SQLAR")
		return
	}

	// Update file record
	if err := w.service.cfg.DB.UpdateFileField(job.filePath, "preview_sqlar", sqlarPath); err != nil {
		log.Error().Err(err).Str("path", job.filePath).Msg("failed to update preview_sqlar")
		return
	}

	// Notify clients
	if w.notifier != nil {
		previewType := "image"
		if isDocumentMime(job.mimeType) {
			previewType = "screenshot"
		}
		w.notifier(job.filePath, previewType)
	}

	log.Info().
		Str("path", job.filePath).
		Str("sqlar", sqlarPath).
		Int("bytes", len(previewData)).
		Msg("preview generated")
}

// generateImageThumbnail creates a JPEG thumbnail for an image file
func (w *previewWorker) generateImageThumbnail(filePath, mimeType string) ([]byte, error) {
	fullPath := filepath.Join(w.service.cfg.DataRoot, filePath)

	f, err := os.Open(fullPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Decode image based on MIME type
	var img image.Image
	switch mimeType {
	case "image/heic", "image/heif":
		img, err = heic.Decode(f)
	case "image/gif":
		img, err = gif.Decode(f)
	case "image/png":
		img, err = png.Decode(f)
	case "image/jpeg":
		img, err = jpeg.Decode(f)
	default:
		// For WebP and other formats, use generic decoder (registered via imports)
		img, _, err = image.Decode(f)
	}
	if err != nil {
		return nil, err
	}

	// Resize to max width
	thumb := resizeToMaxWidth(img, thumbnailMaxWidth)

	// Encode as JPEG
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: thumbnailQuality}); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}

// resizeToMaxWidth scales an image down to maxWidth, preserving aspect ratio.
// Returns the original image if it's already smaller than maxWidth.
func resizeToMaxWidth(src image.Image, maxWidth int) image.Image {
	bounds := src.Bounds()
	srcW := bounds.Dx()
	srcH := bounds.Dy()

	if srcW <= maxWidth {
		return src
	}

	// Calculate new dimensions preserving aspect ratio
	newW := maxWidth
	newH := int(float64(srcH) * float64(maxWidth) / float64(srcW))

	dst := image.NewRGBA(image.Rect(0, 0, newW, newH))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, bounds, draw.Over, nil)
	return dst
}

// generateDocScreenshot generates a PNG screenshot of a document.
// Placeholder — wired up in Task 4.
func (w *previewWorker) generateDocScreenshot(filePath string) ([]byte, error) {
	// TODO: Task 4 — integrate HAID service
	return nil, nil
}

// generateVideoThumbnail extracts a frame from a video.
// Placeholder — wired up in Task 4.
func (w *previewWorker) generateVideoThumbnail(filePath string) ([]byte, error) {
	// TODO: Task 4 — integrate ffmpeg
	return nil, nil
}
```

**Step 3: Add `golang.org/x/image` dependency**

Run: `cd backend && go get golang.org/x/image`

**Step 4: Build and verify**

Run: `cd backend && go build ./...`
Expected: Compiles. The preview worker is defined but not yet wired into the service.

**Step 5: Commit**

```bash
git add backend/fs/preview.go backend/fs/types.go backend/go.mod backend/go.sum
git commit -m "feat: add preview worker infrastructure and image thumbnail generator

New fs/preview.go with:
- Preview worker goroutine with buffered queue
- Image thumbnail generation (JPEG/PNG/WebP/GIF/HEIC → 400px JPEG)
- MIME-type detection helpers
- Placeholder slots for doc screenshots and video thumbnails"
```

---

### Task 3: Wire preview worker into `fs.Service`

Connect the preview worker to the service lifecycle and the file change notification system.

**Files:**
- Modify: `backend/fs/service.go` — add preview worker fields, start in Start(), stop in Stop(), queue in changeNotificationWorker
- Modify: `backend/fs/types.go` — add PreviewNotifier to Config

**Step 1: Add notifier to Config**

In `backend/fs/types.go`, add to Config struct (after line 51):
```go
// Preview notification callback (optional, for SSE)
PreviewNotifier PreviewNotifier
```

**Step 2: Add preview worker to Service struct**

In `backend/fs/service.go`, add field to Service struct (after line 25):
```go
preview *previewWorker
```

**Step 3: Initialize preview worker in NewService**

In `backend/fs/service.go` `NewService()`, after line 51 (`s.processor = newMetadataProcessor(s)`):
```go
s.preview = newPreviewWorker(s, cfg.PreviewNotifier)
```

**Step 4: Start preview worker in Start()**

In `backend/fs/service.go` `Start()`, after line 69 (the existing `go s.changeNotificationWorker()`):
```go
// Start preview worker
s.wg.Add(1)
go func() {
	defer s.wg.Done()
	s.preview.run()
}()
```

**Step 5: Stop preview worker in Stop()**

In `backend/fs/service.go` `Stop()`, before the `s.wg.Wait()` call (line 102), add:
```go
// Close preview queue to stop worker
close(s.preview.queue)
```

**Step 6: Queue previews in changeNotificationWorker**

In `backend/fs/service.go` `changeNotificationWorker()`, inside the event processing (after line 143, before calling handler), add:
```go
// Queue preview generation if file needs one
if event.ContentChanged || event.IsNew {
	file, _ := s.cfg.DB.GetFileByPath(event.FilePath)
	if file != nil && file.MimeType != nil && needsImagePreview(*file.MimeType) {
		s.preview.enqueue(previewJob{
			filePath: event.FilePath,
			mimeType: *file.MimeType,
		})
	}
}
```

**Step 7: Wire up notification service where fs.Service is created**

Find where `fs.NewService(fs.Config{...})` is called (likely in `main.go` or `server.go`). Add the `PreviewNotifier` field:
```go
PreviewNotifier: func(path, previewType string) {
	notifService.NotifyPreviewUpdated(path, previewType)
},
```

**Step 8: Implement SqlarStore and SqlarExists on the DB adapter**

The `fs.Database` interface now requires `SqlarStore` and `SqlarExists`. Find the adapter struct that implements this interface and add:
```go
func (a *dbAdapter) SqlarStore(name string, data []byte, mode int) bool {
	return db.SqlarStore(name, data, mode)
}
func (a *dbAdapter) SqlarExists(name string) bool {
	return db.SqlarExists(name)
}
```

**Step 9: Build and test**

Run: `cd backend && go build ./...`
Expected: Compiles. Preview worker starts with the service and processes file change events.

Run: `cd backend && go test ./fs/...`
Expected: Existing tests pass.

**Step 10: Commit**

```bash
git add backend/fs/service.go backend/fs/types.go
# plus any adapter file and main.go/server.go changes
git commit -m "feat: wire preview worker into fs.Service lifecycle

Preview worker starts/stops with fs.Service. File change events
are checked for MIME type and queued for preview generation.
Notification callback wired to SSE service."
```

---

### Task 4: Doc screenshots + video thumbnails

Implement the two remaining preview generators: HAID-based doc screenshots (moved from digest pipeline) and ffmpeg-based video frame extraction.

**Files:**
- Modify: `backend/fs/preview.go` — implement `generateDocScreenshot` and `generateVideoThumbnail`
- Modify: `backend/fs/types.go` — add HAID client to Config or a DocScreenshotter interface

**Step 1: Add HAID dependency to fs layer**

In `backend/fs/types.go`, add to Config:
```go
// DocScreenshotter generates screenshots of documents (optional, nil = skip doc previews)
DocScreenshotter interface {
	GenerateDocScreenshot(docPath string) ([]byte, error)
}
```

**Step 2: Implement generateDocScreenshot**

In `backend/fs/preview.go`, replace the placeholder:
```go
func (w *previewWorker) generateDocScreenshot(filePath string) ([]byte, error) {
	if w.service.cfg.DocScreenshotter == nil {
		log.Debug().Str("path", filePath).Msg("doc screenshots not configured, skipping")
		return nil, nil
	}

	screenshot, err := w.service.cfg.DocScreenshotter.GenerateDocScreenshot(filePath)
	if err != nil {
		return nil, fmt.Errorf("doc screenshot failed: %w", err)
	}

	return screenshot, nil
}
```

**Step 3: Implement generateVideoThumbnail**

In `backend/fs/preview.go`, replace the placeholder:
```go
func (w *previewWorker) generateVideoThumbnail(filePath string) ([]byte, error) {
	fullPath := filepath.Join(w.service.cfg.DataRoot, filePath)

	// Extract frame at 1 second using ffmpeg
	cmd := exec.CommandContext(
		context.Background(),
		"ffmpeg",
		"-ss", "1",
		"-i", fullPath,
		"-frames:v", "1",
		"-f", "image2pipe",
		"-vcodec", "png",
		"-",
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// If 1s fails (very short video), try 0s
		cmd2 := exec.CommandContext(
			context.Background(),
			"ffmpeg",
			"-ss", "0",
			"-i", fullPath,
			"-frames:v", "1",
			"-f", "image2pipe",
			"-vcodec", "png",
			"-",
		)
		stdout.Reset()
		cmd2.Stdout = &stdout
		cmd2.Stderr = &stderr
		if err := cmd2.Run(); err != nil {
			return nil, fmt.Errorf("ffmpeg failed: %w: %s", err, stderr.String())
		}
	}

	if stdout.Len() == 0 {
		return nil, fmt.Errorf("ffmpeg produced empty output")
	}

	// Decode PNG frame and resize to thumbnail
	img, err := png.Decode(&stdout)
	if err != nil {
		return nil, fmt.Errorf("failed to decode ffmpeg frame: %w", err)
	}

	thumb := resizeToMaxWidth(img, thumbnailMaxWidth)

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: thumbnailQuality}); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}
```

**Step 4: Add imports**

Add `"context"`, `"fmt"`, `"os/exec"` to the imports in `preview.go`.

**Step 5: Wire HAID client where fs.Service is created**

Where `fs.Config` is constructed, add:
```go
DocScreenshotter: vendors.GetHAID(), // may be nil if not configured
```

**Step 6: Build and verify**

Run: `cd backend && go build ./...`
Expected: Compiles.

**Step 7: Commit**

```bash
git add backend/fs/preview.go backend/fs/types.go
# plus any wiring changes
git commit -m "feat: add doc screenshot and video thumbnail generators

Doc screenshots use HAID service (same as removed digester).
Video thumbnails use ffmpeg frame extraction at 1s mark.
Both resize to 400px thumbnail JPEG before SQLAR storage."
```

---

### Task 5: Remove screenshot digesters from pipeline

Now that the preview worker handles all image previews, remove the two digesters that are replaced.

**Files:**
- Modify: `backend/workers/digest/registry.go:74-75` — remove DocToScreenshotDigester and ImagePreviewDigester
- Modify: `backend/workers/digest/worker.go:422-427,502-508` — remove isScreenshotDigester function and screenshot_sqlar update logic
- Modify: `backend/workers/digest/digesters.go:289-400` — remove DocToScreenshotDigester and ImagePreviewDigester structs

**Step 1: Remove from registry**

In `backend/workers/digest/registry.go`, remove from `digesterOrder` (lines 74-75):
```go
// Remove these two lines:
&DocToScreenshotDigester{},
&ImagePreviewDigester{},
```

**Step 2: Remove isScreenshotDigester and preview_sqlar update from worker**

In `backend/workers/digest/worker.go`:

Remove the `isScreenshotDigester` function (lines 422-427).

In `saveDigestOutput` (lines 502-508), remove the block:
```go
// Remove this entire block:
if output.Status == DigestStatusCompleted && isScreenshotDigester(output.Digester) {
	db.UpdateFileField(filePath, "preview_sqlar", sqlarPath)
	w.notifyPreviewReady(filePath, output.Digester)
}
```

Remove `notifyPreviewReady` function (lines 429-444) since no digesters produce previews anymore.

**Step 3: Remove digester implementations**

In `backend/workers/digest/digesters.go`, remove:
- `DocToScreenshotDigester` struct and all its methods (lines 289-329)
- `ImagePreviewDigester` struct and all its methods (lines 331-400)

**Step 4: Build and verify**

Run: `cd backend && go build ./...`
Expected: Compiles. No references to removed code.

Run: `cd backend && go test ./...`
Expected: Tests pass.

**Step 5: Commit**

```bash
git add backend/workers/digest/
git commit -m "refactor: remove screenshot digesters, replaced by fs preview worker

DocToScreenshotDigester and ImagePreviewDigester are removed.
The fs.previewWorker now handles all image preview generation
as a core feature independent of the digest pipeline."
```

---

### Task 6: Scanner catch-up for missing previews

Add logic to the hourly filesystem scanner to detect files that should have image previews but don't (e.g., files ingested before this feature, or previews that failed).

**Files:**
- Modify: `backend/fs/scanner.go` — add missing-preview detection pass
- Modify: `backend/fs/preview.go` — add `queueMissingPreviews` method

**Step 1: Add missing preview detection to preview worker**

In `backend/fs/preview.go`, add:
```go
// queueMissingPreviews finds files that should have image previews but don't
func (w *previewWorker) queueMissingPreviews() {
	// Query files with image/doc/video MIME types that have no preview_sqlar
	rows, err := db.GetDB().Query(`
		SELECT path, mime_type FROM files
		WHERE is_folder = 0
		  AND mime_type IS NOT NULL
		  AND preview_sqlar IS NULL
		  AND (
			mime_type LIKE 'image/%'
			OR mime_type LIKE 'video/%'
			OR mime_type IN (
				'application/pdf',
				'application/msword',
				'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				'application/vnd.ms-excel',
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
				'application/vnd.ms-powerpoint',
				'application/vnd.openxmlformats-officedocument.presentationml.presentation'
			)
		  )
		LIMIT 50
	`)
	if err != nil {
		log.Warn().Err(err).Msg("failed to query files missing previews")
		return
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var path, mimeType string
		if err := rows.Scan(&path, &mimeType); err != nil {
			continue
		}
		w.enqueue(previewJob{filePath: path, mimeType: mimeType})
		count++
	}

	if count > 0 {
		log.Info().Int("count", count).Msg("queued files with missing previews")
	}
}
```

**Step 2: Call from scanner**

In `backend/fs/scanner.go`, at the end of each scan cycle, add:
```go
// Check for missing previews
s.service.preview.queueMissingPreviews()
```

Find the scan completion point (after reconciliation) and add this call.

**Step 3: Build and test**

Run: `cd backend && go build ./...`
Expected: Compiles.

**Step 4: Commit**

```bash
git add backend/fs/preview.go backend/fs/scanner.go
git commit -m "feat: scanner detects and queues files with missing previews

Hourly scan now finds files that should have image previews but
don't (null preview_sqlar with image/doc/video MIME types) and
queues them for generation. Limit 50 per scan to avoid overload."
```

---

## Notes for the implementer

### Key architectural decisions
- **preview_sqlar path convention**: `{GeneratePathHash(filePath)}/preview/{filename}` — different from digest paths (`{hash}/{digester}/{filename}`). This keeps preview SQLAR entries visually distinct.
- **File move handling**: When a file is moved, `preview_sqlar` keeps its old value. The SQLAR data is keyed by the OLD path hash, so it still works until the file content changes and a new preview is generated. Consider adding preview re-link on move in a future iteration.
- **Concurrency**: The preview worker processes jobs sequentially from a single goroutine. This is intentional — thumbnail generation is I/O bound and sequential processing prevents overwhelming the disk. If parallelism is needed later, add a worker pool.

### Files affected summary

| File | Change |
|------|--------|
| `backend/db/migration_011_preview_sqlar.go` | NEW — schema migration |
| `backend/db/models.go` | Rename field |
| `backend/db/files.go` | Rename all SQL + Go references |
| `backend/db/pins.go` | Rename references |
| `backend/fs/preview.go` | NEW — preview worker + generators |
| `backend/fs/types.go` | Extend Database interface + Config |
| `backend/fs/service.go` | Wire preview worker |
| `backend/fs/scanner.go` | Missing preview detection |
| `backend/api/inbox.go` | Rename field |
| `backend/api/search.go` | Rename field + SQL |
| `backend/workers/digest/registry.go` | Remove 2 digesters |
| `backend/workers/digest/worker.go` | Remove screenshot logic |
| `backend/workers/digest/digesters.go` | Remove 2 digester implementations |
| `frontend/app/types/file-record.ts` | Rename field |
| `frontend/app/types/file-card.ts` | Rename field |
| `frontend/app/types/api.ts` | Rename field |
| `frontend/app/components/FileCard/utils.ts` | Rename field |
| `backend/go.mod` + `go.sum` | Add `golang.org/x/image` |

### Dependencies
- `golang.org/x/image` — for `draw.CatmullRom.Scale` (high-quality image resizing) and WebP decode support
- `github.com/gen2brain/heic` — already in go.mod, for HEIC/HEIF decode
- `ffmpeg` — must be installed on the host for video thumbnail extraction
