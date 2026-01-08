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
	TextSourceURLCrawl       TextSourceType = "url-crawl-content"
	TextSourceDocToMarkdown  TextSourceType = "doc-to-markdown"
	TextSourceImageOCR       TextSourceType = "image-ocr"
	TextSourceImageCaptioning TextSourceType = "image-captioning"
	TextSourceSpeech         TextSourceType = "speech-recognition"
	TextSourceFile           TextSourceType = "file"
)

// TextContent represents extracted text with its source
type TextContent struct {
	Text   string
	Source TextSourceType
}

// GetURLCrawlMarkdown extracts markdown content from url-crawl-content digest
func GetURLCrawlMarkdown(existingDigests []db.Digest) string {
	for _, d := range existingDigests {
		if d.Digester == "url-crawl-content" && d.Status == "completed" && d.Content != nil {
			return extractURLCrawlMarkdown(*d.Content)
		}
	}
	return ""
}

func extractURLCrawlMarkdown(content string) string {
	// Try to parse as JSON with markdown field
	var parsed struct {
		Markdown string `json:"markdown"`
	}
	if err := json.Unmarshal([]byte(content), &parsed); err == nil && parsed.Markdown != "" {
		return parsed.Markdown
	}
	return content
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

// GetImageOCRText gets OCR text content
func GetImageOCRText(existingDigests []db.Digest) string {
	for _, d := range existingDigests {
		if d.Digester == "image-ocr" && d.Status == "completed" && d.Content != nil {
			return *d.Content
		}
	}
	return ""
}

// GetImageCaptioningText gets image captioning text
func GetImageCaptioningText(existingDigests []db.Digest) string {
	for _, d := range existingDigests {
		if d.Digester == "image-captioning" && d.Status == "completed" && d.Content != nil {
			return *d.Content
		}
	}
	return ""
}

// GetSpeechRecognitionText gets speech recognition text
func GetSpeechRecognitionText(existingDigests []db.Digest) string {
	for _, d := range existingDigests {
		if d.Digester == "speech-recognition" && d.Status == "completed" && d.Content != nil {
			content := *d.Content
			// Parse transcript JSON to extract plain text
			var parsed struct {
				Segments []struct {
					Text string `json:"text"`
				} `json:"segments"`
			}
			if err := json.Unmarshal([]byte(content), &parsed); err == nil && len(parsed.Segments) > 0 {
				var texts []string
				for _, s := range parsed.Segments {
					texts = append(texts, s.Text)
				}
				return strings.Join(texts, " ")
			}
			return content
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

// HasURLCrawlContent checks if url-crawl content exists with minimum length
func HasURLCrawlContent(existingDigests []db.Digest, minLength int) bool {
	markdown := GetURLCrawlMarkdown(existingDigests)
	return len(strings.TrimSpace(markdown)) >= minLength
}

// HasDocToMarkdownContent checks if doc-to-markdown content exists
func HasDocToMarkdownContent(existingDigests []db.Digest, minLength int) bool {
	content := GetDocToMarkdown(existingDigests)
	return len(strings.TrimSpace(content)) >= minLength
}

// HasImageOCRContent checks if OCR content exists
func HasImageOCRContent(existingDigests []db.Digest, minLength int) bool {
	content := GetImageOCRText(existingDigests)
	return len(strings.TrimSpace(content)) >= minLength
}

// HasImageCaptioningContent checks if captioning content exists
func HasImageCaptioningContent(existingDigests []db.Digest, minLength int) bool {
	content := GetImageCaptioningText(existingDigests)
	return len(strings.TrimSpace(content)) >= minLength
}

// HasSpeechRecognitionContent checks if speech content exists
func HasSpeechRecognitionContent(existingDigests []db.Digest, minLength int) bool {
	content := GetSpeechRecognitionText(existingDigests)
	return len(strings.TrimSpace(content)) >= minLength
}

// HasAnyTextSource checks if any text source is available
func HasAnyTextSource(file *db.FileRecord, existingDigests []db.Digest, minLength int) bool {
	if HasURLCrawlContent(existingDigests, minLength) {
		return true
	}
	if HasDocToMarkdownContent(existingDigests, minLength) {
		return true
	}
	if HasImageOCRContent(existingDigests, minLength) {
		return true
	}
	if HasImageCaptioningContent(existingDigests, minLength) {
		return true
	}
	if HasSpeechRecognitionContent(existingDigests, minLength) {
		return true
	}
	return HasLocalTextContent(file)
}

// ReadLocalFile reads a text file from data directory
func ReadLocalFile(filePath string) (string, error) {
	cfg := config.Get()
	fullPath := filepath.Join(cfg.DataDir, filePath)

	data, err := os.ReadFile(fullPath)
	if err != nil {
		log.Warn().Str("path", filePath).Err(err).Msg("failed to read text file")
		return "", err
	}

	return string(data), nil
}

// GetPrimaryTextContent gets the primary text content for a file with priority order:
// 1. URL crawl content (highest priority for URLs)
// 2. Document to markdown (for PDFs, DOCX, etc.)
// 3. Image OCR (primary for images)
// 4. Image captioning (fallback for images without OCR text)
// 5. Speech recognition (for audio/video)
// 6. Local file content (for text files)
func GetPrimaryTextContent(filePath string, file *db.FileRecord, existingDigests []db.Digest) *TextContent {
	// 1. URL crawl content (highest priority for URLs)
	if text := GetURLCrawlMarkdown(existingDigests); text != "" {
		return &TextContent{Text: text, Source: TextSourceURLCrawl}
	}

	// 2. Document to markdown (for PDFs, DOCX, etc.)
	if text := GetDocToMarkdown(existingDigests); text != "" {
		return &TextContent{Text: text, Source: TextSourceDocToMarkdown}
	}

	// 3. Image OCR (primary for images)
	if text := GetImageOCRText(existingDigests); text != "" {
		return &TextContent{Text: text, Source: TextSourceImageOCR}
	}

	// 4. Image captioning (fallback for images without OCR text)
	if text := GetImageCaptioningText(existingDigests); text != "" {
		return &TextContent{Text: text, Source: TextSourceImageCaptioning}
	}

	// 5. Speech recognition (for audio/video)
	if text := GetSpeechRecognitionText(existingDigests); text != "" {
		return &TextContent{Text: text, Source: TextSourceSpeech}
	}

	// 6. Local file content (for text files)
	if !file.IsFolder && HasLocalTextContent(file) {
		text, err := ReadLocalFile(filePath)
		if err == nil && text != "" {
			return &TextContent{Text: text, Source: TextSourceFile}
		}
	}

	return nil
}
