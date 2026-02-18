package fs

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

const (
	// Maximum bytes to read for text preview
	maxPreviewBytes = 10 * 1024 * 1024 // 10MB

	// Maximum lines to include in text preview
	maxPreviewLines = 60
)

// metadataProcessor handles hash computation and text preview extraction
type metadataProcessor struct {
	service *Service
}

// newMetadataProcessor creates a new metadata processor
func newMetadataProcessor(service *Service) *metadataProcessor {
	return &metadataProcessor{
		service: service,
	}
}

// ComputeMetadata computes hash and text preview for a file
func (p *metadataProcessor) ComputeMetadata(ctx context.Context, path string) (*MetadataResult, error) {
	fullPath := filepath.Join(p.service.cfg.DataRoot, path)

	file, err := os.Open(fullPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, err
	}

	// Check if context is cancelled before starting expensive operation
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	// Compute hash
	hash, err := p.computeHash(file)
	if err != nil {
		log.Error().Err(err).Str("path", path).Msg("failed to compute hash")
		return nil, err
	}

	// Reset file pointer for text preview
	if _, err := file.Seek(0, 0); err != nil {
		return nil, err
	}

	// Extract text preview (if applicable)
	var textPreview *string
	if p.isTextFile(path) {
		preview, err := p.extractTextPreview(file)
		if err != nil {
			log.Warn().Err(err).Str("path", path).Msg("failed to extract text preview")
			// Non-fatal: continue without preview
		} else if preview != nil && *preview != "" {
			textPreview = preview
		}
	}

	return &MetadataResult{
		Hash:        hash,
		TextPreview: textPreview,
		Size:        info.Size(),
	}, nil
}

// computeHash computes SHA-256 hash of file content
func (p *metadataProcessor) computeHash(r io.Reader) (string, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// extractTextPreview extracts first N lines of text from a file
func (p *metadataProcessor) extractTextPreview(r io.Reader) (*string, error) {
	limited := io.LimitReader(r, maxPreviewBytes)
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 0, 64*1024), maxPreviewBytes)

	var lines []string
	for scanner.Scan() && len(lines) < maxPreviewLines {
		lines = append(lines, scanner.Text())
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	if len(lines) == 0 {
		return nil, nil
	}

	preview := strings.Join(lines, "\n")
	return &preview, nil
}

// isTextFile checks if a file is a text file based on extension
func (p *metadataProcessor) isTextFile(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	textExts := []string{
		".txt", ".md", ".markdown",
		".json", ".yaml", ".yml",
		".log", ".csv", ".tsv",
		".xml", ".html", ".htm",
		".js", ".ts", ".jsx", ".tsx",
		".py", ".go", ".java", ".c", ".cpp", ".h",
		".sh", ".bash", ".zsh",
		".sql", ".conf", ".config",
		".ini", ".toml",
	}

	for _, textExt := range textExts {
		if ext == textExt {
			return true
		}
	}

	return false
}
