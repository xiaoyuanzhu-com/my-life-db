package utils

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// TextSourceType represents the source of text content
type TextSourceType string

const (
	TextSourceDocToMarkdown TextSourceType = "doc-to-markdown"
	TextSourceFile          TextSourceType = "file"
)

// TextContent represents extracted text with its source
type TextContent struct {
	Text   string
	Source TextSourceType
}

// GetDocToMarkdown gets doc-to-markdown content
func GetDocToMarkdown(existingDigests []db.Digest) string {
	for _, d := range existingDigests {
		if d.Digester == "doc-to-markdown" && d.Status == "completed" && d.Content != nil {
			return *d.Content
		}
	}
	return ""
}

// GetSummaryText gets url-crawl-summary text
func GetSummaryText(existingDigests []db.Digest) string {
	for _, d := range existingDigests {
		if d.Digester == "url-crawl-summary" && d.Content != nil {
			content := *d.Content
			var parsed struct {
				Summary string `json:"summary"`
			}
			if err := json.Unmarshal([]byte(content), &parsed); err == nil && parsed.Summary != "" {
				return parsed.Summary
			}
			return content
		}
	}
	return ""
}

// IsTextFile checks if a file is a text file based on MIME type and filename
func IsTextFile(mimeType *string, filename string) bool {
	// Check by MIME type
	if mimeType != nil {
		mt := *mimeType
		if strings.HasPrefix(mt, "text/") {
			return true
		}
		textMimeTypes := []string{
			"application/json",
			"application/javascript",
			"application/xml",
			"application/x-yaml",
			"application/yaml",
		}
		for _, tm := range textMimeTypes {
			if mt == tm {
				return true
			}
		}
	}

	// Check by extension
	ext := strings.ToLower(filepath.Ext(filename))
	textExtensions := map[string]bool{
		".txt": true, ".md": true, ".markdown": true, ".json": true,
		".yaml": true, ".yml": true, ".xml": true, ".html": true,
		".htm": true, ".css": true, ".js": true, ".ts": true,
		".jsx": true, ".tsx": true, ".py": true, ".go": true,
		".rs": true, ".java": true, ".c": true, ".cpp": true,
		".h": true, ".hpp": true, ".sh": true, ".bash": true,
		".zsh": true, ".fish": true, ".sql": true, ".toml": true,
		".ini": true, ".cfg": true, ".conf": true, ".log": true,
		".env": true, ".gitignore": true, ".dockerignore": true,
	}
	return textExtensions[ext]
}

// HasLocalTextContent checks if file is a text file
func HasLocalTextContent(file *db.FileRecord) bool {
	if file.IsFolder {
		return false
	}
	return IsTextFile(file.MimeType, file.Name)
}

// HasDocToMarkdownContent checks if doc-to-markdown content exists
func HasDocToMarkdownContent(existingDigests []db.Digest, minLength int) bool {
	content := GetDocToMarkdown(existingDigests)
	return len(strings.TrimSpace(content)) >= minLength
}

// HasAnyTextSource checks if any text source is available
func HasAnyTextSource(file *db.FileRecord, existingDigests []db.Digest, minLength int) bool {
	if HasDocToMarkdownContent(existingDigests, minLength) {
		return true
	}
	return HasLocalTextContent(file)
}

// ReadLocalFile reads a text file from data directory
func ReadLocalFile(filePath string) (string, error) {
	cfg := config.Get()
	fullPath := filepath.Join(cfg.UserDataDir, filePath)

	data, err := os.ReadFile(fullPath)
	if err != nil {
		log.Warn().Str("path", filePath).Err(err).Msg("failed to read text file")
		return "", err
	}

	return string(data), nil
}

// GetPrimaryTextContent gets the primary text content for a file with priority order:
// 1. Document to markdown (for PDFs, DOCX, etc.)
// 2. Local file content (for text files)
func GetPrimaryTextContent(filePath string, file *db.FileRecord, existingDigests []db.Digest) *TextContent {
	// 1. Document to markdown (for PDFs, DOCX, etc.)
	if text := GetDocToMarkdown(existingDigests); text != "" {
		return &TextContent{Text: text, Source: TextSourceDocToMarkdown}
	}

	// 2. Local file content (for text files)
	if !file.IsFolder && HasLocalTextContent(file) {
		text, err := ReadLocalFile(filePath)
		if err == nil && text != "" {
			return &TextContent{Text: text, Source: TextSourceFile}
		}
	}

	return nil
}
