package api

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/mholt/archives"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

// archiveExtensions lists supported archive file extensions (lowercase, with leading dot).
var archiveExtensions = []string{
	".zip",
	".tar",
	".tar.gz", ".tgz",
	".tar.bz2", ".tbz2",
	".tar.xz", ".txz",
	".tar.zst",
	".7z",
	".rar",
}

// isArchiveFile returns true if the filename has a supported archive extension.
// Matching is case-insensitive.
func isArchiveFile(filename string) bool {
	lower := strings.ToLower(filename)
	for _, ext := range archiveExtensions {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// isJunkArchiveEntry returns true for entries that should be skipped during extraction.
// This includes macOS resource forks (__MACOSX/), .DS_Store, and Thumbs.db.
func isJunkArchiveEntry(path string) bool {
	if strings.HasPrefix(path, "__MACOSX/") || path == "__MACOSX" {
		return true
	}
	base := filepath.Base(path)
	return base == ".DS_Store" || base == "Thumbs.db"
}

// isSafeArchivePath validates that an archive entry path is safe to extract.
// It rejects empty paths, absolute paths, and paths containing ".." components
// to prevent zip-slip attacks.
func isSafeArchivePath(path string) bool {
	if path == "" {
		return false
	}
	if filepath.IsAbs(path) {
		return false
	}
	// Check for ".." path traversal
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		if part == ".." {
			return false
		}
	}
	return true
}

// extractArchive extracts an archive file into the given destination directory.
// It uses mholt/archives to auto-detect the format and extract entries.
// Returns a list of uploadFileResult for each successfully extracted file.
func (h *Handlers) extractArchive(ctx context.Context, archivePath, destRelDir string) ([]uploadFileResult, error) {
	f, err := os.Open(archivePath)
	if err != nil {
		return nil, fmt.Errorf("open archive: %w", err)
	}
	defer f.Close()

	// Identify the archive format
	format, _, err := archives.Identify(ctx, filepath.Base(archivePath), f)
	if err != nil {
		return nil, fmt.Errorf("identify archive format: %w", err)
	}

	extractor, ok := format.(archives.Extractor)
	if !ok {
		return nil, fmt.Errorf("format %T does not support extraction", format)
	}

	// Reset file position after Identify read some bytes
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("seek archive: %w", err)
	}

	cfg := config.Get()
	var results []uploadFileResult

	err = extractor.Extract(ctx, f, func(ctx context.Context, fi archives.FileInfo) error {
		nameInArchive := fi.NameInArchive

		// Skip directories
		if fi.IsDir() {
			return nil
		}

		// Skip junk entries
		if isJunkArchiveEntry(nameInArchive) {
			log.Debug().Str("entry", nameInArchive).Msg("archive: skipping junk entry")
			return nil
		}

		// Validate path safety (zip-slip prevention)
		if !isSafeArchivePath(nameInArchive) {
			log.Warn().Str("entry", nameInArchive).Msg("archive: skipping unsafe path")
			return nil
		}

		// Build the relative destination path
		relPath := filepath.Join(destRelDir, nameInArchive)

		// Ensure parent directory exists on disk
		absDir := filepath.Join(cfg.UserDataDir, filepath.Dir(relPath))
		if err := os.MkdirAll(absDir, 0755); err != nil {
			log.Error().Err(err).Str("dir", absDir).Msg("archive: failed to create parent dir")
			return nil
		}

		// Open the entry for reading
		rc, err := fi.Open()
		if err != nil {
			log.Error().Err(err).Str("entry", nameInArchive).Msg("archive: failed to open entry")
			return nil
		}
		defer rc.Close()

		// Detect MIME type from filename
		mimeType := utils.DetectMimeType(filepath.Base(nameInArchive))

		// Write via fs.Service
		_, writeErr := h.server.FS().WriteFile(ctx, fs.WriteRequest{
			Path:            relPath,
			Content:         rc,
			MimeType:        mimeType,
			Source:          "upload",
			ComputeMetadata: true,
			Sync:            true,
		})
		if writeErr != nil {
			log.Error().Err(writeErr).Str("path", relPath).Msg("archive: failed to write extracted file")
			return nil
		}

		log.Info().Str("path", relPath).Msg("archive: extracted file")
		results = append(results, uploadFileResult{Path: relPath, Status: "created"})
		return nil
	})
	if err != nil {
		return results, fmt.Errorf("extract archive: %w", err)
	}

	return results, nil
}
