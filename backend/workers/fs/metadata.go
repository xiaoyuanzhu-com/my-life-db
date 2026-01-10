package fs

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

// FileMetadata represents computed file metadata
type FileMetadata struct {
	Path        string
	Name        string
	IsFolder    bool
	Size        int64
	MimeType    string
	Hash        string  // SHA-256 hex string
	ModifiedAt  string  // RFC3339
	TextPreview *string // First 60 lines (text files only)
}

// ProcessFileMetadata computes all metadata for a file
// Returns FileMetadata ready to be inserted/updated in database
func ProcessFileMetadata(relPath string) (*FileMetadata, error) {
	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, relPath)

	// Get file info
	info, err := os.Stat(fullPath)
	if err != nil {
		return nil, err
	}

	// Skip directories
	if info.IsDir() {
		return &FileMetadata{
			Path:       relPath,
			Name:       filepath.Base(relPath),
			IsFolder:   true,
			Size:       0,
			ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
		}, nil
	}

	// Basic metadata
	metadata := &FileMetadata{
		Path:       relPath,
		Name:       filepath.Base(relPath),
		IsFolder:   false,
		Size:       info.Size(),
		MimeType:   utils.DetectMimeType(filepath.Base(relPath)),
		ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
	}

	// Compute hash and text preview
	if err := computeHashAndPreview(fullPath, metadata); err != nil {
		// Log but don't fail - partial metadata is better than none
		log.Warn().Err(err).Str("path", relPath).Msg("failed to compute hash/preview")
	}

	return metadata, nil
}

// computeHashAndPreview reads file once to compute both hash and preview
func computeHashAndPreview(fullPath string, metadata *FileMetadata) error {
	// Open file
	f, err := os.Open(fullPath)
	if err != nil {
		return err
	}
	defer f.Close()

	// Check if it's a text file
	isText := utils.IsTextFile(&metadata.MimeType, metadata.Name)

	// Strategy:
	// - For small files (<10MB): Read fully, compute hash + preview
	// - For large files (>=10MB):
	//   - If text: Read first 10MB for preview, stream rest for hash
	//   - If binary: Stream entire file for hash only

	const maxPreviewSize = 10 * 1024 * 1024 // 10MB
	const previewLines = 60                  // First 60 lines (50 visible + 10 buffer)

	if metadata.Size < maxPreviewSize {
		// Small file: read fully into memory
		data, err := io.ReadAll(f)
		if err != nil {
			return err
		}

		// Compute hash
		hash := sha256.Sum256(data)
		metadata.Hash = hex.EncodeToString(hash[:])

		// Extract preview if text
		if isText {
			preview := extractTextPreview(data, previewLines)
			metadata.TextPreview = &preview
		}
	} else {
		// Large file: streaming approach
		hasher := sha256.New()

		if isText {
			// Read first chunk for preview
			previewBuf := make([]byte, maxPreviewSize)
			n, _ := io.ReadFull(f, previewBuf)
			preview := extractTextPreview(previewBuf[:n], previewLines)
			metadata.TextPreview = &preview

			// Hash the preview chunk
			hasher.Write(previewBuf[:n])

			// Stream rest for hash
			io.Copy(hasher, f)
		} else {
			// Binary file: just hash
			io.Copy(hasher, f)
		}

		metadata.Hash = hex.EncodeToString(hasher.Sum(nil))
	}

	return nil
}

// extractTextPreview extracts first 60 lines, handling UTF-8 safely
// Matches Node.js implementation: content.split('\n').slice(0, 60).join('\n')
func extractTextPreview(data []byte, maxLines int) string {
	if maxLines <= 0 {
		maxLines = 60 // Default: 50 visible + 10 buffer
	}

	// Convert to string (handles UTF-8)
	text := string(data)

	// Split by lines
	lines := strings.Split(text, "\n")

	// Take first N lines
	if len(lines) <= maxLines {
		return text
	}

	return strings.Join(lines[:maxLines], "\n")
}

// ShouldReprocessMetadata checks if file needs metadata recomputation
// by comparing hash with database record
func ShouldReprocessMetadata(filePath string, newHash string) (bool, error) {
	existing, err := db.GetFileByPath(filePath)
	if err != nil {
		return false, err
	}
	if existing == nil {
		return true, nil // New file
	}
	if existing.Hash == nil {
		return true, nil // Missing hash
	}
	return *existing.Hash != newHash, nil // Hash changed
}
