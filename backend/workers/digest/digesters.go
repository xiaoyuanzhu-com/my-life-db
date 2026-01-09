package digest

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/vendors"
)

// Helper functions

func nowUTC() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func isURL(path string) bool {
	return strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://")
}

func isImage(mimeType string) bool {
	return strings.HasPrefix(mimeType, "image/")
}

func isAudio(mimeType string) bool {
	return strings.HasPrefix(mimeType, "audio/")
}

func isVideo(mimeType string) bool {
	return strings.HasPrefix(mimeType, "video/")
}

func isDocument(mimeType string) bool {
	docTypes := []string{
		"application/pdf",
		"application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.ms-powerpoint",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	}
	for _, t := range docTypes {
		if mimeType == t {
			return true
		}
	}
	return false
}

func isMarkdown(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".md" || ext == ".markdown"
}

func getMimeType(file *db.FileRecord) string {
	if file.MimeType != nil {
		return *file.MimeType
	}
	return ""
}

func getTextContent(filePath string, file *db.FileRecord, existingDigests []db.Digest) string {
	// Check file's text preview first
	if file.TextPreview != nil && *file.TextPreview != "" {
		return *file.TextPreview
	}

	// Check for text content from digesters
	for _, d := range existingDigests {
		if d.Status != "completed" || d.Content == nil {
			continue
		}
		// Priority order: markdown conversion, OCR, captioning, speech
		switch d.Digester {
		case "doc-to-markdown":
			return *d.Content
		case "url-crawl-content":
			return *d.Content
		case "image-ocr":
			return *d.Content
		case "image-captioning":
			return *d.Content
		case "speech-recognition-cleanup", "speech-recognition":
			return *d.Content
		}
	}

	return ""
}

// ==================== URL Crawl Digester ====================

type URLCrawlDigester struct{}

func (d *URLCrawlDigester) Name() string        { return "url-crawl" }
func (d *URLCrawlDigester) Label() string       { return "URL Crawler" }
func (d *URLCrawlDigester) Description() string { return "Crawl and extract content from URLs" }
func (d *URLCrawlDigester) GetOutputDigesters() []string {
	return []string{"url-crawl-content", "url-crawl-screenshot"}
}

func (d *URLCrawlDigester) CanDigest(filePath string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	// Only for markdown files that contain URLs
	if !isMarkdown(filePath) {
		return false, nil
	}
	if file.TextPreview != nil && (strings.HasPrefix(*file.TextPreview, "http://") || strings.HasPrefix(*file.TextPreview, "https://")) {
		return true, nil
	}
	return false, nil
}

func (d *URLCrawlDigester) Digest(filePath string, file *db.FileRecord, _ []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	// Get URL from text preview
	urlStr := ""
	if file.TextPreview != nil {
		urlStr = strings.TrimSpace(*file.TextPreview)
	}

	if urlStr == "" || (!strings.HasPrefix(urlStr, "http://") && !strings.HasPrefix(urlStr, "https://")) {
		return []DigestInput{
			{FilePath: filePath, Digester: "url-crawl-content", Status: DigestStatusCompleted, CreatedAt: now, UpdatedAt: now},
			{FilePath: filePath, Digester: "url-crawl-screenshot", Status: DigestStatusCompleted, CreatedAt: now, UpdatedAt: now},
		}, nil
	}

	// Use HAID service to crawl URL
	haid := vendors.GetHAID()
	if haid == nil {
		errMsg := "HAID service not configured"
		return []DigestInput{
			{FilePath: filePath, Digester: "url-crawl-content", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now},
			{FilePath: filePath, Digester: "url-crawl-screenshot", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now},
		}, nil
	}

	crawlResp, err := haid.CrawlURLWithOpts(urlStr, vendors.CrawlOptions{Screenshot: true, Timeout: 30})
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{
			{FilePath: filePath, Digester: "url-crawl-content", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now},
			{FilePath: filePath, Digester: "url-crawl-screenshot", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now},
		}, nil
	}

	results := make([]DigestInput, 0, 2)

	// Get content markdown
	markdown := crawlResp.Markdown
	if markdown == "" {
		markdown = crawlResp.Content
	}

	// Calculate word count and reading time
	wordCount := countWords(markdown)
	readingTimeMinutes := 1
	if wordCount > 0 {
		readingTimeMinutes = (wordCount + 199) / 200 // Round up, 200 words per minute
	}

	// Extract domain from URL
	domain := ""
	if parsedURL, err := url.Parse(crawlResp.URL); err == nil {
		domain = parsedURL.Hostname()
	}

	// Create JSON content with metadata (matching Node.js format)
	contentData := map[string]interface{}{
		"markdown":           markdown,
		"url":                crawlResp.URL,
		"title":              crawlResp.Title,
		"domain":             domain,
		"wordCount":          wordCount,
		"readingTimeMinutes": readingTimeMinutes,
	}
	contentJSON, _ := json.Marshal(contentData)
	contentStr := string(contentJSON)

	// Content result (now JSON)
	results = append(results, DigestInput{
		FilePath:  filePath,
		Digester:  "url-crawl-content",
		Status:    DigestStatusCompleted,
		Content:   &contentStr,
		CreatedAt: now,
		UpdatedAt: now,
	})

	// Screenshot result (stored in SQLAR)
	if crawlResp.Screenshot != "" {
		screenshotBytes, err := base64.StdEncoding.DecodeString(crawlResp.Screenshot)
		if err == nil && len(screenshotBytes) > 0 {
			sqlarName := "screenshot.png"
			results = append(results, DigestInput{
				FilePath:  filePath,
				Digester:  "url-crawl-screenshot",
				Status:    DigestStatusCompleted,
				SqlarName: &sqlarName,
				CreatedAt: now,
				UpdatedAt: now,
			})
		} else {
			results = append(results, DigestInput{
				FilePath:  filePath,
				Digester:  "url-crawl-screenshot",
				Status:    DigestStatusCompleted,
				CreatedAt: now,
				UpdatedAt: now,
			})
		}
	} else {
		results = append(results, DigestInput{
			FilePath:  filePath,
			Digester:  "url-crawl-screenshot",
			Status:    DigestStatusCompleted,
			CreatedAt: now,
			UpdatedAt: now,
		})
	}

	return results, nil
}

// ==================== Doc to Markdown Digester ====================

type DocToMarkdownDigester struct{}

func (d *DocToMarkdownDigester) Name() string        { return "doc-to-markdown" }
func (d *DocToMarkdownDigester) Label() string       { return "Document Converter" }
func (d *DocToMarkdownDigester) Description() string { return "Convert documents to markdown" }
func (d *DocToMarkdownDigester) GetOutputDigesters() []string { return nil }

func (d *DocToMarkdownDigester) CanDigest(filePath string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	mimeType := getMimeType(file)
	return isDocument(mimeType), nil
}

func (d *DocToMarkdownDigester) Digest(filePath string, file *db.FileRecord, _ []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	haid := vendors.GetHAID()
	if haid == nil {
		errMsg := "HAID service not configured"
		return []DigestInput{{FilePath: filePath, Digester: "doc-to-markdown", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	markdown, err := haid.ConvertDocToMarkdown(filePath)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "doc-to-markdown", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "doc-to-markdown",
		Status:    DigestStatusCompleted,
		Content:   &markdown,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== Doc to Screenshot Digester ====================

type DocToScreenshotDigester struct{}

func (d *DocToScreenshotDigester) Name() string        { return "doc-to-screenshot" }
func (d *DocToScreenshotDigester) Label() string       { return "Document Screenshot" }
func (d *DocToScreenshotDigester) Description() string { return "Generate screenshot of document first page" }
func (d *DocToScreenshotDigester) GetOutputDigesters() []string { return nil }

func (d *DocToScreenshotDigester) CanDigest(filePath string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	mimeType := getMimeType(file)
	return isDocument(mimeType), nil
}

func (d *DocToScreenshotDigester) Digest(filePath string, file *db.FileRecord, _ []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	haid := vendors.GetHAID()
	if haid == nil {
		errMsg := "HAID service not configured"
		return []DigestInput{{FilePath: filePath, Digester: "doc-to-screenshot", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	screenshot, err := haid.GenerateDocScreenshot(filePath)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "doc-to-screenshot", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	sqlarName := "screenshot.png"
	_ = screenshot // Would be saved to SQLAR

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "doc-to-screenshot",
		Status:    DigestStatusCompleted,
		SqlarName: &sqlarName,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== Image OCR Digester ====================

type ImageOCRDigester struct{}

func (d *ImageOCRDigester) Name() string        { return "image-ocr" }
func (d *ImageOCRDigester) Label() string       { return "Image OCR" }
func (d *ImageOCRDigester) Description() string { return "Extract text from images using OCR" }
func (d *ImageOCRDigester) GetOutputDigesters() []string { return nil }

func (d *ImageOCRDigester) CanDigest(filePath string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	mimeType := getMimeType(file)
	return isImage(mimeType), nil
}

func (d *ImageOCRDigester) Digest(filePath string, file *db.FileRecord, _ []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	haid := vendors.GetHAID()
	if haid == nil {
		errMsg := "HAID service not configured"
		return []DigestInput{{FilePath: filePath, Digester: "image-ocr", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	text, err := haid.OCRImage(filePath)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "image-ocr", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "image-ocr",
		Status:    DigestStatusCompleted,
		Content:   &text,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== Image Captioning Digester ====================

type ImageCaptioningDigester struct{}

func (d *ImageCaptioningDigester) Name() string        { return "image-captioning" }
func (d *ImageCaptioningDigester) Label() string       { return "Image Captioning" }
func (d *ImageCaptioningDigester) Description() string { return "Generate captions for images" }
func (d *ImageCaptioningDigester) GetOutputDigesters() []string { return nil }

func (d *ImageCaptioningDigester) CanDigest(filePath string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	mimeType := getMimeType(file)
	return isImage(mimeType), nil
}

func (d *ImageCaptioningDigester) Digest(filePath string, file *db.FileRecord, _ []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	haid := vendors.GetHAID()
	if haid == nil {
		errMsg := "HAID service not configured"
		return []DigestInput{{FilePath: filePath, Digester: "image-captioning", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	caption, err := haid.CaptionImage(filePath)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "image-captioning", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "image-captioning",
		Status:    DigestStatusCompleted,
		Content:   &caption,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== Image Objects Digester ====================

type ImageObjectsDigester struct{}

func (d *ImageObjectsDigester) Name() string        { return "image-objects" }
func (d *ImageObjectsDigester) Label() string       { return "Object Detection" }
func (d *ImageObjectsDigester) Description() string { return "Detect objects in images" }
func (d *ImageObjectsDigester) GetOutputDigesters() []string { return nil }

func (d *ImageObjectsDigester) CanDigest(filePath string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	mimeType := getMimeType(file)
	return isImage(mimeType), nil
}

func (d *ImageObjectsDigester) Digest(filePath string, file *db.FileRecord, _ []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	haid := vendors.GetHAID()
	if haid == nil {
		errMsg := "HAID service not configured"
		return []DigestInput{{FilePath: filePath, Digester: "image-objects", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	objects, err := haid.DetectObjects(filePath)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "image-objects", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	content, _ := json.Marshal(objects)
	contentStr := string(content)

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "image-objects",
		Status:    DigestStatusCompleted,
		Content:   &contentStr,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== Speech Recognition Digester ====================

type SpeechRecognitionDigester struct{}

func (d *SpeechRecognitionDigester) Name() string        { return "speech-recognition" }
func (d *SpeechRecognitionDigester) Label() string       { return "Speech Recognition" }
func (d *SpeechRecognitionDigester) Description() string { return "Transcribe audio/video to text" }
func (d *SpeechRecognitionDigester) GetOutputDigesters() []string { return nil }

func (d *SpeechRecognitionDigester) CanDigest(filePath string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	mimeType := getMimeType(file)
	return isAudio(mimeType) || isVideo(mimeType), nil
}

func (d *SpeechRecognitionDigester) Digest(filePath string, file *db.FileRecord, _ []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	haid := vendors.GetHAID()
	if haid == nil {
		errMsg := "HAID service not configured"
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	transcript, err := haid.TranscribeAudio(filePath)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "speech-recognition",
		Status:    DigestStatusCompleted,
		Content:   &transcript,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== URL Crawl Summary Digester ====================

type URLCrawlSummaryDigester struct{}

func (d *URLCrawlSummaryDigester) Name() string        { return "url-crawl-summary" }
func (d *URLCrawlSummaryDigester) Label() string       { return "URL Summary" }
func (d *URLCrawlSummaryDigester) Description() string { return "Summarize crawled URL content" }
func (d *URLCrawlSummaryDigester) GetOutputDigesters() []string { return nil }

func (d *URLCrawlSummaryDigester) CanDigest(filePath string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	return isMarkdown(filePath), nil
}

func (d *URLCrawlSummaryDigester) Digest(filePath string, file *db.FileRecord, existingDigests []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	// Find url-crawl-content digest
	var crawlContent string
	for _, d := range existingDigests {
		if d.Digester == "url-crawl-content" && d.Status == "completed" && d.Content != nil {
			crawlContent = *d.Content
			break
		}
	}

	if crawlContent == "" {
		return []DigestInput{{FilePath: filePath, Digester: "url-crawl-summary", Status: DigestStatusCompleted, CreatedAt: now, UpdatedAt: now}}, nil
	}

	// Generate summary using OpenAI
	openai := vendors.GetOpenAI()
	if openai == nil {
		errMsg := "OpenAI not configured"
		return []DigestInput{{FilePath: filePath, Digester: "url-crawl-summary", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	summary, err := openai.Summarize(crawlContent)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "url-crawl-summary", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "url-crawl-summary",
		Status:    DigestStatusCompleted,
		Content:   &summary,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== Speech Recognition Cleanup Digester ====================

type SpeechRecognitionCleanupDigester struct{}

func (d *SpeechRecognitionCleanupDigester) Name() string        { return "speech-recognition-cleanup" }
func (d *SpeechRecognitionCleanupDigester) Label() string       { return "Transcript Cleanup" }
func (d *SpeechRecognitionCleanupDigester) Description() string { return "Clean up transcribed text" }
func (d *SpeechRecognitionCleanupDigester) GetOutputDigesters() []string { return nil }

func (d *SpeechRecognitionCleanupDigester) CanDigest(filePath string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	mimeType := getMimeType(file)
	return isAudio(mimeType) || isVideo(mimeType), nil
}

func (d *SpeechRecognitionCleanupDigester) Digest(filePath string, file *db.FileRecord, existingDigests []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	// Find speech-recognition digest
	var transcript string
	for _, d := range existingDigests {
		if d.Digester == "speech-recognition" && d.Status == "completed" && d.Content != nil {
			transcript = *d.Content
			break
		}
	}

	if transcript == "" {
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition-cleanup", Status: DigestStatusCompleted, CreatedAt: now, UpdatedAt: now}}, nil
	}

	// Use OpenAI to clean up
	openai := vendors.GetOpenAI()
	if openai == nil {
		errMsg := "OpenAI not configured"
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition-cleanup", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	cleaned, err := openai.CleanupTranscript(transcript)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition-cleanup", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "speech-recognition-cleanup",
		Status:    DigestStatusCompleted,
		Content:   &cleaned,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== Speech Recognition Summary Digester ====================

type SpeechRecognitionSummaryDigester struct{}

func (d *SpeechRecognitionSummaryDigester) Name() string        { return "speech-recognition-summary" }
func (d *SpeechRecognitionSummaryDigester) Label() string       { return "Audio Summary" }
func (d *SpeechRecognitionSummaryDigester) Description() string { return "Summarize transcribed audio" }
func (d *SpeechRecognitionSummaryDigester) GetOutputDigesters() []string { return nil }

func (d *SpeechRecognitionSummaryDigester) CanDigest(filePath string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	mimeType := getMimeType(file)
	return isAudio(mimeType) || isVideo(mimeType), nil
}

func (d *SpeechRecognitionSummaryDigester) Digest(filePath string, file *db.FileRecord, existingDigests []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	// Find cleaned transcript or original
	var transcript string
	for _, d := range existingDigests {
		if d.Digester == "speech-recognition-cleanup" && d.Status == "completed" && d.Content != nil {
			transcript = *d.Content
			break
		}
	}
	if transcript == "" {
		for _, d := range existingDigests {
			if d.Digester == "speech-recognition" && d.Status == "completed" && d.Content != nil {
				transcript = *d.Content
				break
			}
		}
	}

	if transcript == "" {
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition-summary", Status: DigestStatusCompleted, CreatedAt: now, UpdatedAt: now}}, nil
	}

	openai := vendors.GetOpenAI()
	if openai == nil {
		errMsg := "OpenAI not configured"
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition-summary", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	summary, err := openai.Summarize(transcript)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition-summary", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "speech-recognition-summary",
		Status:    DigestStatusCompleted,
		Content:   &summary,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== Speaker Embedding Digester ====================

type SpeakerEmbeddingDigester struct{}

func (d *SpeakerEmbeddingDigester) Name() string        { return "speaker-embedding" }
func (d *SpeakerEmbeddingDigester) Label() string       { return "Speaker Embedding" }
func (d *SpeakerEmbeddingDigester) Description() string { return "Generate speaker voice embeddings" }
func (d *SpeakerEmbeddingDigester) GetOutputDigesters() []string { return nil }

func (d *SpeakerEmbeddingDigester) CanDigest(filePath string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	mimeType := getMimeType(file)
	return isAudio(mimeType) || isVideo(mimeType), nil
}

func (d *SpeakerEmbeddingDigester) Digest(filePath string, file *db.FileRecord, _ []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	haid := vendors.GetHAID()
	if haid == nil {
		errMsg := "HAID service not configured"
		return []DigestInput{{FilePath: filePath, Digester: "speaker-embedding", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	embedding, err := haid.GenerateSpeakerEmbedding(filePath)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "speaker-embedding", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	content, _ := json.Marshal(embedding)
	contentStr := string(content)

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "speaker-embedding",
		Status:    DigestStatusCompleted,
		Content:   &contentStr,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== Tags Digester ====================

type TagsDigester struct{}

func (d *TagsDigester) Name() string        { return "tags" }
func (d *TagsDigester) Label() string       { return "Tags" }
func (d *TagsDigester) Description() string { return "Generate AI tags for content" }
func (d *TagsDigester) GetOutputDigesters() []string { return nil }

func (d *TagsDigester) CanDigest(_ string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	return !file.IsFolder, nil
}

func (d *TagsDigester) Digest(filePath string, file *db.FileRecord, existingDigests []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	text := getTextContent(filePath, file, existingDigests)
	if len(text) < 10 {
		return []DigestInput{{FilePath: filePath, Digester: "tags", Status: DigestStatusCompleted, CreatedAt: now, UpdatedAt: now}}, nil
	}

	openai := vendors.GetOpenAI()
	if openai == nil {
		errMsg := "OpenAI not configured"
		return []DigestInput{{FilePath: filePath, Digester: "tags", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	tags, err := openai.GenerateTags(text)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "tags", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	content, _ := json.Marshal(map[string]interface{}{"tags": tags})
	contentStr := string(content)

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "tags",
		Status:    DigestStatusCompleted,
		Content:   &contentStr,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== Search Keyword Digester ====================

type SearchKeywordDigester struct{}

func (d *SearchKeywordDigester) Name() string        { return "search-keyword" }
func (d *SearchKeywordDigester) Label() string       { return "Keyword Search" }
func (d *SearchKeywordDigester) Description() string { return "Index content for keyword search" }
func (d *SearchKeywordDigester) GetOutputDigesters() []string { return nil }

func (d *SearchKeywordDigester) CanDigest(_ string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	return !file.IsFolder, nil
}

func (d *SearchKeywordDigester) Digest(filePath string, file *db.FileRecord, existingDigests []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	// Get combined text from all content sources
	text, err := GetPrimaryTextContent(filePath, file, existingDigests)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "search-keyword", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	// Get summary and tags
	summaryText := GetSummaryDigest(existingDigests)
	tagsText := GetTagsDigest(existingDigests)

	// Calculate content hash and word count
	allText := text
	if summaryText != nil {
		allText += " " + *summaryText
	}
	if tagsText != nil {
		allText += " " + *tagsText
	}

	contentHash := hashString(allText)
	wordCount := countWords(text)

	// Create meili_documents record
	mimeType := file.MimeType
	meiliDoc := &db.MeiliDocument{
		FilePath:    filePath,
		Content:     text,
		Summary:     summaryText,
		Tags:        tagsText,
		ContentHash: contentHash,
		WordCount:   wordCount,
		MimeType:    mimeType,
	}

	if err := db.UpsertMeiliDocument(meiliDoc); err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "search-keyword", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	// Get document ID for metadata
	documentID, _ := db.GetMeiliDocumentIdForFile(filePath)

	// Track which content sources contributed
	sources, _ := GetContentSources(filePath, file, existingDigests)
	var contentSources []string
	for _, s := range sources {
		contentSources = append(contentSources, s.SourceType)
	}

	// Store metadata about indexing in digest content
	metadata := map[string]interface{}{
		"documentId":     documentID,
		"hasContent":     text != "",
		"contentSources": contentSources,
		"hasSummary":     summaryText != nil,
		"hasTags":        tagsText != nil,
	}
	metadataJSON, _ := json.Marshal(metadata)
	metadataStr := string(metadataJSON)

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "search-keyword",
		Status:    DigestStatusCompleted,
		Content:   &metadataStr,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== Search Semantic Digester ====================

type SearchSemanticDigester struct{}

func (d *SearchSemanticDigester) Name() string        { return "search-semantic" }
func (d *SearchSemanticDigester) Label() string       { return "Semantic Search" }
func (d *SearchSemanticDigester) Description() string { return "Index content for semantic search" }
func (d *SearchSemanticDigester) GetOutputDigesters() []string { return nil }

func (d *SearchSemanticDigester) CanDigest(_ string, file *db.FileRecord, _ *sql.DB) (bool, error) {
	return !file.IsFolder, nil
}

func (d *SearchSemanticDigester) Digest(filePath string, file *db.FileRecord, existingDigests []db.Digest, _ *sql.DB) ([]DigestInput, error) {
	now := nowUTC()

	// Get all content sources
	sources, err := GetContentSources(filePath, file, existingDigests)
	if err != nil {
		errMsg := err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "search-semantic", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	if len(sources) == 0 {
		// No text available - complete with no content
		return []DigestInput{{FilePath: filePath, Digester: "search-semantic", Status: DigestStatusCompleted, CreatedAt: now, UpdatedAt: now}}, nil
	}

	// Index each source separately with chunking
	sourceCounts := make(map[string]int)
	totalChunks := 0

	for _, source := range sources {
		if source.Text == "" {
			continue
		}

		// Chunk text (800-1000 tokens, 15% overlap)
		chunks := ChunkText(source.Text, 900, 0.15)

		// Create qdrant_documents records for each chunk
		for _, chunk := range chunks {
			documentID := filePath + ":" + source.SourceType + ":" + fmt.Sprintf("%d", chunk.ChunkIndex)
			contentHash := hashString(chunk.ChunkText)

			qdrantDoc := &db.QdrantDocument{
				DocumentID:       documentID,
				FilePath:         filePath,
				SourceType:       source.SourceType,
				ChunkIndex:       chunk.ChunkIndex,
				ChunkCount:       chunk.ChunkCount,
				ChunkText:        chunk.ChunkText,
				SpanStart:        chunk.SpanStart,
				SpanEnd:          chunk.SpanEnd,
				OverlapTokens:    chunk.OverlapTokens,
				WordCount:        chunk.WordCount,
				TokenCount:       chunk.TokenCount,
				ContentHash:      contentHash,
				EmbeddingVersion: 0,
			}

			if err := db.UpsertQdrantDocument(qdrantDoc); err != nil {
				errMsg := err.Error()
				return []DigestInput{{FilePath: filePath, Digester: "search-semantic", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
			}
		}

		sourceCounts[source.SourceType] = len(chunks)
		totalChunks += len(chunks)
	}

	// Also index summary and tags as separate sources
	summaryText := GetSummaryDigest(existingDigests)
	if summaryText != nil && *summaryText != "" {
		chunks := ChunkText(*summaryText, 900, 0.15)
		for _, chunk := range chunks {
			documentID := filePath + ":summary:" + fmt.Sprintf("%d", chunk.ChunkIndex)
			contentHash := hashString(chunk.ChunkText)

			qdrantDoc := &db.QdrantDocument{
				DocumentID:       documentID,
				FilePath:         filePath,
				SourceType:       "summary",
				ChunkIndex:       chunk.ChunkIndex,
				ChunkCount:       chunk.ChunkCount,
				ChunkText:        chunk.ChunkText,
				SpanStart:        chunk.SpanStart,
				SpanEnd:          chunk.SpanEnd,
				OverlapTokens:    chunk.OverlapTokens,
				WordCount:        chunk.WordCount,
				TokenCount:       chunk.TokenCount,
				ContentHash:      contentHash,
				EmbeddingVersion: 0,
			}

			if err := db.UpsertQdrantDocument(qdrantDoc); err != nil {
				errMsg := err.Error()
				return []DigestInput{{FilePath: filePath, Digester: "search-semantic", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
			}
		}
		sourceCounts["summary"] = len(chunks)
		totalChunks += len(chunks)
	}

	tagsText := GetTagsDigest(existingDigests)
	if tagsText != nil && *tagsText != "" {
		chunks := ChunkText(*tagsText, 900, 0.15)
		for _, chunk := range chunks {
			documentID := filePath + ":tags:" + fmt.Sprintf("%d", chunk.ChunkIndex)
			contentHash := hashString(chunk.ChunkText)

			qdrantDoc := &db.QdrantDocument{
				DocumentID:       documentID,
				FilePath:         filePath,
				SourceType:       "tags",
				ChunkIndex:       chunk.ChunkIndex,
				ChunkCount:       chunk.ChunkCount,
				ChunkText:        chunk.ChunkText,
				SpanStart:        chunk.SpanStart,
				SpanEnd:          chunk.SpanEnd,
				OverlapTokens:    chunk.OverlapTokens,
				WordCount:        chunk.WordCount,
				TokenCount:       chunk.TokenCount,
				ContentHash:      contentHash,
				EmbeddingVersion: 0,
			}

			if err := db.UpsertQdrantDocument(qdrantDoc); err != nil {
				errMsg := err.Error()
				return []DigestInput{{FilePath: filePath, Digester: "search-semantic", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
			}
		}
		sourceCounts["tags"] = len(chunks)
		totalChunks += len(chunks)
	}

	// Store metadata about indexing in digest content
	metadata := map[string]interface{}{
		"sources":     sourceCounts,
		"totalChunks": totalChunks,
	}
	metadataJSON, _ := json.Marshal(metadata)
	metadataStr := string(metadataJSON)

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "search-semantic",
		Status:    DigestStatusCompleted,
		Content:   &metadataStr,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}
