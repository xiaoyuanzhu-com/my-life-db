package utils

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// SanitizeFilename removes or replaces problematic characters from filenames
func SanitizeFilename(filename string) string {
	// Remove path separators
	filename = filepath.Base(filename)

	// Replace problematic characters
	replacer := strings.NewReplacer(
		"<", "_",
		">", "_",
		":", "_",
		"\"", "_",
		"|", "_",
		"?", "_",
		"*", "_",
	)
	return replacer.Replace(filename)
}

// DeduplicateFilename generates a unique filename using macOS-style naming (e.g., "photo 2.jpg")
func DeduplicateFilename(dir, filename string) string {
	ext := filepath.Ext(filename)
	base := strings.TrimSuffix(filename, ext)

	result := filename
	counter := 2

	for {
		fullPath := filepath.Join(dir, result)
		if _, err := os.Stat(fullPath); os.IsNotExist(err) {
			return result
		}
		result = base + " " + strconv.Itoa(counter) + ext
		counter++
	}
}

// DedupAction describes what should happen with an uploaded file
type DedupAction string

const (
	DedupActionWrite DedupAction = "created" // New file or name collision with different content (after rename)
	DedupActionSkip  DedupAction = "skipped" // Exact duplicate: same name + same content
)

// DedupResult contains the outcome of duplicate detection
type DedupResult struct {
	Action   DedupAction // "created" or "skipped"
	Filename string      // Final filename to use (may be renamed)
}

// DeduplicateFileWithHash checks for content-level duplicates before falling back to filename deduplication.
//
// Logic:
//  1. If no file exists at dir/filename → write (no collision)
//  2. If file exists and incomingHash matches existingHash → skip (exact duplicate)
//  3. If file exists and hashes differ → auto-rename (macOS-style "file 2.ext")
//
// The existingHashFn callback lets callers provide the hash from the database
// without this package depending on the db package.
func DeduplicateFileWithHash(dir, filename, incomingHash string, existingHashFn func(relPath string) string) DedupResult {
	fullPath := filepath.Join(dir, filename)

	// No collision — file doesn't exist yet
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		return DedupResult{Action: DedupActionWrite, Filename: filename}
	}

	// File exists — check content hash
	if incomingHash != "" {
		existingHash := existingHashFn(filename)
		if existingHash != "" && existingHash == incomingHash {
			// Exact duplicate: same destination, same name, same content → skip
			return DedupResult{Action: DedupActionSkip, Filename: filename}
		}
	}

	// File exists but content differs (or hash unavailable) → auto-rename
	renamed := DeduplicateFilename(dir, filename)
	return DedupResult{Action: DedupActionWrite, Filename: renamed}
}

// ComputeFileHash computes the SHA-256 hash of the given reader's content.
// Returns the hex-encoded hash string.
func ComputeFileHash(r io.Reader) (string, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// DetectMimeType detects MIME type based on file extension
func DetectMimeType(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))

	mimeTypes := map[string]string{
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".png":  "image/png",
		".gif":  "image/gif",
		".webp": "image/webp",
		".svg":  "image/svg+xml",
		".bmp":  "image/bmp",
		".ico":  "image/x-icon",
		".tiff": "image/tiff",
		".tif":  "image/tiff",
		".heic": "image/heic",
		".heif": "image/heif",
		".mp4":  "video/mp4",
		".mov":  "video/quicktime",
		".avi":  "video/x-msvideo",
		".mkv":  "video/x-matroska",
		".webm": "video/webm",
		".mp3":  "audio/mpeg",
		".wav":  "audio/wav",
		".flac": "audio/flac",
		".aac":  "audio/aac",
		".ogg":  "audio/ogg",
		".m4a":  "audio/mp4",
		".pdf":  "application/pdf",
		".doc":  "application/msword",
		".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".xls":  "application/vnd.ms-excel",
		".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		".ppt":  "application/vnd.ms-powerpoint",
		".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		".txt":  "text/plain",
		".md":   "text/markdown",
		".json": "application/json",
		".html": "text/html",
		".htm":  "text/html",
		".css":  "text/css",
		".js":   "application/javascript",
		".xml":  "application/xml",
		".zip":  "application/zip",
		".rar":  "application/x-rar-compressed",
		".tar":  "application/x-tar",
		".gz":   "application/gzip",
		".7z":   "application/x-7z-compressed",
	}

	if mime, ok := mimeTypes[ext]; ok {
		return mime
	}
	return "application/octet-stream"
}
