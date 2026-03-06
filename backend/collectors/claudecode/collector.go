// Package claudecode syncs Claude Code session files from a source directory
// into the MyLifeDB imports tree.
package claudecode

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SyncResult reports the outcome of a sync operation.
type SyncResult struct {
	Copied  int
	Skipped int
	Errors  int
}

// Collector syncs Claude Code session files from sourceDir to destDir.
type Collector struct {
	sourceDir string
	destDir   string
}

// New creates a Collector that copies matching files from sourceDir to destDir.
func New(sourceDir, destDir string) *Collector {
	return &Collector{
		sourceDir: sourceDir,
		destDir:   destDir,
	}
}

// Sync walks the source directory and copies new or changed files to the
// destination. It returns a SyncResult summarizing what happened.
// If the source directory does not exist, it returns an empty result (not an error).
func (c *Collector) Sync(ctx context.Context) (SyncResult, error) {
	var result SyncResult

	// If source doesn't exist, return empty result.
	if _, err := os.Stat(c.sourceDir); errors.Is(err, fs.ErrNotExist) {
		return result, nil
	} else if err != nil {
		return result, fmt.Errorf("stat source dir: %w", err)
	}

	err := filepath.WalkDir(c.sourceDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		// Check for cancellation.
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if d.IsDir() {
			return nil
		}

		if !shouldSync(d.Name()) {
			return nil
		}

		rel, err := filepath.Rel(c.sourceDir, path)
		if err != nil {
			return err
		}
		destPath := filepath.Join(c.destDir, rel)

		needed, err := copyNeeded(path, destPath)
		if err != nil {
			log.Error().Err(err).Str("file", rel).Msg("failed to compare files")
			result.Errors++
			return nil
		}

		if !needed {
			result.Skipped++
			return nil
		}

		if err := copyFile(path, destPath); err != nil {
			log.Error().Err(err).Str("file", rel).Msg("failed to copy file")
			result.Errors++
			return nil
		}

		result.Copied++
		return nil
	})

	if err != nil {
		return result, fmt.Errorf("walk source dir: %w", err)
	}

	if result.Copied > 0 || result.Errors > 0 {
		log.Info().
			Int("copied", result.Copied).
			Int("skipped", result.Skipped).
			Int("errors", result.Errors).
			Msg("claude code collector sync complete")
	}

	return result, nil
}

// shouldSync returns true if the filename should be synced.
func shouldSync(name string) bool {
	if strings.HasSuffix(name, ".jsonl") {
		return true
	}
	if name == "sessions-index.json" {
		return true
	}
	return false
}

// copyNeeded returns true if the source file needs to be copied to dest.
// It returns true if dest doesn't exist, or if the files differ by size or content hash.
func copyNeeded(src, dst string) (bool, error) {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return false, fmt.Errorf("stat source: %w", err)
	}

	dstInfo, err := os.Stat(dst)
	if errors.Is(err, fs.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("stat dest: %w", err)
	}

	// Fast path: different sizes means different content.
	if srcInfo.Size() != dstInfo.Size() {
		return true, nil
	}

	// Same size: compare SHA-256 hashes.
	srcHash, err := fileHash(src)
	if err != nil {
		return false, fmt.Errorf("hash source: %w", err)
	}
	dstHash, err := fileHash(dst)
	if err != nil {
		return false, fmt.Errorf("hash dest: %w", err)
	}

	return srcHash != dstHash, nil
}

// fileHash computes the SHA-256 hex digest of a file.
func fileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", h.Sum(nil)), nil
}

// copyFile copies src to dst, creating parent directories as needed.
func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}

	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("create dest: %w", err)
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return fmt.Errorf("copy: %w", err)
	}

	return out.Close()
}
