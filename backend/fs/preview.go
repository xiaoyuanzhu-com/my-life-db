package fs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gen2brain/heic"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
	"golang.org/x/image/draw"

	// Register WebP decoder so image.Decode can handle it
	_ "golang.org/x/image/webp"
)

const (
	thumbnailMaxWidth = 1200
	thumbnailQuality  = 85
	previewCacheLimit = 256 * 1024 * 1024
)

type previewWorker struct {
	service *Service
	gate    chan struct{} // One generator; canceled requests do not wait in a queue.
}

func newPreviewWorker(service *Service) *previewWorker {
	return &previewWorker{service: service, gate: make(chan struct{}, 1)}
}

// Preview generates thumbnails only when requested. Cache data is disposable
// and lives outside SQLite, so browsing does not grow a database WAL.
func (s *Service) Preview(ctx context.Context, path string) ([]byte, error) {
	if err := s.validator.ValidatePath(path); err != nil {
		return nil, err
	}
	fullPath := filepath.Join(s.cfg.DataRoot, path)
	resolved, err := filepath.EvalSymlinks(fullPath)
	if err != nil {
		return nil, err
	}
	root, err := filepath.EvalSymlinks(s.cfg.DataRoot)
	if err != nil {
		return nil, err
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil, ErrInvalidPath
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, ErrInvalidPath
	}
	// Avoid unbounded image decoding and document rendering for giant inputs.
	if info.Size() > 64*1024*1024 {
		return nil, fmt.Errorf("file too large for a thumbnail")
	}
	mime := utils.DetectMimeType(path)
	if !needsPreview(mime) {
		return nil, fmt.Errorf("unsupported preview type")
	}
	w := s.preview
	select {
	case w.gate <- struct{}{}:
		defer func() { <-w.gate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cacheDir := s.cfg.PreviewCacheDir
	if cacheDir == "" {
		return nil, fmt.Errorf("preview cache not configured")
	}
	if err := os.MkdirAll(cacheDir, 0700); err != nil {
		return nil, err
	}
	key := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d", path, info.Size(), info.ModTime().UnixNano())))
	cachePath := filepath.Join(cacheDir, fmt.Sprintf("%x.jpg", key))
	if data, err := os.ReadFile(cachePath); err == nil {
		now := time.Now()
		_ = os.Chtimes(cachePath, now, now)
		return data, nil
	}
	var data []byte
	if isImageMime(mime) {
		data, err = w.generateImageThumbnail(path, mime)
	} else {
		data, err = w.generateDocumentPreview(ctx, path)
	}
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(data) > previewCacheLimit {
		return nil, fmt.Errorf("thumbnail exceeds cache limit")
	}
	if err := trimPreviewCache(cacheDir, int64(previewCacheLimit-len(data))); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(cacheDir, ".preview-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(data); err != nil {
		tmp.Close()
		return nil, err
	}
	if err = tmp.Close(); err != nil {
		return nil, err
	}
	if err = os.Rename(tmp.Name(), cachePath); err != nil {
		return nil, err
	}
	return data, nil
}

func trimPreviewCache(dir string, budget int64) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	files := []os.FileInfo{}
	var total int64
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		files = append(files, info)
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].ModTime().Before(files[j].ModTime()) })
	for _, file := range files {
		if total <= budget {
			break
		}
		if err := os.Remove(filepath.Join(dir, file.Name())); err != nil {
			return err
		}
		total -= file.Size()
	}
	return nil
}

// ---------- MIME type helpers ----------

// needsPreview returns true for MIME types that support preview generation
func needsPreview(mimeType string) bool {
	return isImageMime(mimeType) || isDocumentMime(mimeType)
}

// isImageMime returns true for image/* MIME types
func isImageMime(mimeType string) bool {
	return strings.HasPrefix(mimeType, "image/")
}

// isDocumentMime returns true for MIME types that screenitshot can render.
func isDocumentMime(mimeType string) bool {
	switch mimeType {
	case "application/pdf",
		"application/epub+zip",
		"application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.ms-powerpoint",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"text/csv",
		"application/rtf",
		"text/html",
		"text/markdown":
		return true
	}
	return false
}

// ---------- Document preview (screenitshot) ----------

// generateDocumentPreview runs screenitshot CLI to produce a PNG screenshot
// of a document, then resizes and encodes it as a JPEG thumbnail.
func (w *previewWorker) generateDocumentPreview(parent context.Context, filePath string) ([]byte, error) {
	fullPath := filepath.Join(w.service.cfg.DataRoot, filePath)

	tmpFile, err := os.CreateTemp("", "screenitshot-*.png")
	if err != nil {
		return nil, fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	tmpFile.Close()
	defer os.Remove(tmpPath)

	ctx, cancel := context.WithTimeout(parent, 60*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "screenitshot", fullPath, "-o", tmpPath)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("screenitshot: %w: %s", err, stderr.String())
	}

	f, err := os.Open(tmpPath)
	if err != nil {
		return nil, fmt.Errorf("open screenshot: %w", err)
	}
	defer f.Close()

	if err := checkPreviewDimensions(f); err != nil {
		return nil, err
	}
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, fmt.Errorf("decode screenshot: %w", err)
	}

	// Resize and encode as JPEG thumbnail
	thumb := resizeToMaxWidth(img, thumbnailMaxWidth)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: thumbnailQuality}); err != nil {
		return nil, fmt.Errorf("encode document thumbnail: %w", err)
	}

	return buf.Bytes(), nil
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

	if err := checkPreviewDimensions(f); err != nil {
		return nil, err
	}
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

func checkPreviewDimensions(f *os.File) error {
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return fmt.Errorf("read image dimensions: %w", err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > 40_000_000/cfg.Height {
		return fmt.Errorf("image too large for a thumbnail")
	}
	_, err = f.Seek(0, 0)
	return err
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
