package digest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
)

// ContentSource represents a single content source with its text
type ContentSource struct {
	SourceType string
	Text       string
}

// GetContentSources returns all available content sources for a file
// Each source is returned separately for independent indexing in Qdrant
//
// Source priority order:
// 1. doc-to-markdown (raw content)
// 2. image-objects (parse JSON, extract titles/descriptions)
// 3. file (read .md/.txt from filesystem)
// 4. file (read text.md from folder)
func GetContentSources(filePath string, file *db.FileRecord, existingDigests []db.Digest) ([]ContentSource, error) {
	cfg := config.Get()
	dataDir := cfg.GetDataRoot()
	var sources []ContentSource

	// 1. Check for doc-to-markdown digest
	for _, d := range existingDigests {
		if d.Digester == "doc-to-markdown" && d.Status == "completed" && d.Content != nil {
			sources = append(sources, ContentSource{
				SourceType: "doc-to-markdown",
				Text:       *d.Content,
			})
			break
		}
	}

	// 2. Check for image-objects digest
	for _, d := range existingDigests {
		if d.Digester == "image-objects" && d.Status == "completed" && d.Content != nil {
			// Parse JSON and extract object descriptions
			var objectsData struct {
				Objects []struct {
					Title       string `json:"title"`
					Description string `json:"description"`
				} `json:"objects"`
			}
			if err := json.Unmarshal([]byte(*d.Content), &objectsData); err == nil && len(objectsData.Objects) > 0 {
				var objectTexts []string
				for _, obj := range objectsData.Objects {
					var parts []string
					if obj.Title != "" {
						parts = append(parts, obj.Title)
					}
					if obj.Description != "" {
						parts = append(parts, obj.Description)
					}
					if len(parts) > 0 {
						objectTexts = append(objectTexts, strings.Join(parts, ": "))
					}
				}
				if len(objectTexts) > 0 {
					sources = append(sources, ContentSource{
						SourceType: "image-objects",
						Text:       strings.Join(objectTexts, "\n"),
					})
				}
			}
			break
		}
	}

	// 3. Try reading from filesystem (markdown or text files)
	if strings.HasSuffix(strings.ToLower(filePath), ".md") || strings.HasSuffix(strings.ToLower(filePath), ".txt") {
		fullPath := filepath.Join(dataDir, filePath)
		if content, err := os.ReadFile(fullPath); err == nil {
			sources = append(sources, ContentSource{
				SourceType: "file",
				Text:       string(content),
			})
		}
	}

	// 4. Try folder's text.md
	if file.IsFolder {
		textMdPath := filepath.Join(dataDir, filePath, "text.md")
		if content, err := os.ReadFile(textMdPath); err == nil {
			sources = append(sources, ContentSource{
				SourceType: "file",
				Text:       string(content),
			})
		}
	}

	return sources, nil
}

// GetPrimaryTextContent returns combined text from all sources
// Used by keyword search and tags digester
// Returns empty string if no text available
func GetPrimaryTextContent(filePath string, file *db.FileRecord, existingDigests []db.Digest) (string, error) {
	sources, err := GetContentSources(filePath, file, existingDigests)
	if err != nil {
		return "", err
	}

	if len(sources) == 0 {
		return "", nil
	}

	// Combine all sources with double newline separator
	var texts []string
	for _, source := range sources {
		if source.Text != "" {
			texts = append(texts, source.Text)
		}
	}

	return strings.Join(texts, "\n\n"), nil
}

// GetSummaryDigest finds and returns summary content from digests
func GetSummaryDigest(existingDigests []db.Digest) *string {
	for _, d := range existingDigests {
		if d.Digester == "url-crawl-summary" && d.Status == "completed" && d.Content != nil {
			// Try to parse as JSON
			var summaryData struct {
				Summary string `json:"summary"`
			}
			if err := json.Unmarshal([]byte(*d.Content), &summaryData); err == nil && summaryData.Summary != "" {
				return &summaryData.Summary
			}
			// Fallback to raw content
			return d.Content
		}
	}

	return nil
}

// GetTagsDigest finds and returns tags from digests
// Returns comma-separated tags string or nil
func GetTagsDigest(existingDigests []db.Digest) *string {
	for _, d := range existingDigests {
		if d.Digester == "tags" && d.Status == "completed" && d.Content != nil {
			// Try to parse as JSON
			var tagsData struct {
				Tags []string `json:"tags"`
			}
			if err := json.Unmarshal([]byte(*d.Content), &tagsData); err == nil && len(tagsData.Tags) > 0 {
				tags := strings.Join(tagsData.Tags, ", ")
				return &tags
			}

			// Try parsing as plain array
			var tagsArray []string
			if err := json.Unmarshal([]byte(*d.Content), &tagsArray); err == nil && len(tagsArray) > 0 {
				tags := strings.Join(tagsArray, ", ")
				return &tags
			}
		}
	}

	return nil
}
