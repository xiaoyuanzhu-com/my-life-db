package digest

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/vendors"
)

// Helper functions

func nowUTC() int64 {
	return time.Now().UnixMilli()
}

func isAudio(mimeType string) bool {
	return strings.HasPrefix(mimeType, "audio/")
}

func isVideo(mimeType string) bool {
	return strings.HasPrefix(mimeType, "video/")
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

	// Load settings to determine ASR provider
	settings, err := db.LoadUserSettings()
	if err != nil {
		errMsg := "failed to load settings: " + err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	var asrResp *vendors.ASRResponse

	// Determine which ASR provider to use
	provider := "fun-asr" // Default to Aliyun Fun-ASR
	if settings.Vendors != nil && settings.Vendors.Aliyun != nil && settings.Vendors.Aliyun.ASRProvider != "" {
		provider = settings.Vendors.Aliyun.ASRProvider
	}

	log.Info().Str("provider", provider).Str("filePath", filePath).Msg("using ASR provider")

	switch provider {
	case "fun-asr", "fun-asr-realtime":
		// Use Aliyun Fun-ASR
		aliyun := vendors.GetAliyun()
		if aliyun == nil {
			errMsg := "Aliyun service not configured"
			return []DigestInput{{FilePath: filePath, Digester: "speech-recognition", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
		}

		asrResp, err = aliyun.SpeechRecognition(filePath, vendors.ASROptions{Diarization: false})
		if err != nil {
			errMsg := err.Error()
			return []DigestInput{{FilePath: filePath, Digester: "speech-recognition", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
		}

	default:
		errMsg := fmt.Sprintf("unknown ASR provider: %s", provider)
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	// Store the full ASR response as JSON (matching Node.js implementation)
	asrJSON, err := json.Marshal(asrResp)
	if err != nil {
		errMsg := "failed to marshal ASR response: " + err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}
	content := string(asrJSON)

	return []DigestInput{{
		FilePath:  filePath,
		Digester:  "speech-recognition",
		Status:    DigestStatusCompleted,
		Content:   &content,
		CreatedAt: now,
		UpdatedAt: now,
	}}, nil
}

// ==================== Speech Recognition Cleanup Digester ====================

// prepareASRForLLM strips embeddings and word-level data from ASR response
// to reduce token usage when sending to LLM
func prepareASRForLLM(asrResp vendors.ASRResponse) map[string]interface{} {
	prepared := map[string]interface{}{
		"request_id":         asrResp.RequestID,
		"processing_time_ms": asrResp.ProcessingTimeMs,
		"text":               asrResp.Text,
		"language":           asrResp.Language,
		"model":              asrResp.Model,
	}

	// Strip word-level data from segments to reduce token usage
	segments := make([]map[string]interface{}, len(asrResp.Segments))
	for i, seg := range asrResp.Segments {
		segments[i] = map[string]interface{}{
			"start":   seg.Start,
			"end":     seg.End,
			"text":    seg.Text,
			"speaker": seg.Speaker,
		}
	}
	prepared["segments"] = segments

	// Add speakers without embeddings (only metadata)
	if len(asrResp.Speakers) > 0 {
		speakers := make([]map[string]interface{}, len(asrResp.Speakers))
		for i, speaker := range asrResp.Speakers {
			speakers[i] = map[string]interface{}{
				"speaker_id":     speaker.SpeakerID,
				"total_duration": speaker.TotalDuration,
				"segment_count":  speaker.SegmentCount,
			}
		}
		prepared["speakers"] = speakers
	}

	return prepared
}

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
	var asrContent string
	for _, d := range existingDigests {
		if d.Digester == "speech-recognition" && d.Status == "completed" && d.Content != nil {
			asrContent = *d.Content
			break
		}
	}

	if asrContent == "" {
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition-cleanup", Status: DigestStatusCompleted, CreatedAt: now, UpdatedAt: now}}, nil
	}

	// Parse ASR response and strip embeddings to reduce token usage
	var asrResp vendors.ASRResponse
	if err := json.Unmarshal([]byte(asrContent), &asrResp); err != nil {
		errMsg := "failed to parse ASR response: " + err.Error()
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition-cleanup", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	// Prepare for LLM: strip embeddings and word-level data
	preparedResp := prepareASRForLLM(asrResp)
	preparedJSON, _ := json.Marshal(preparedResp)
	preparedStr := string(preparedJSON)

	// Use OpenAI to clean up
	openai := vendors.GetOpenAI()
	if openai == nil {
		errMsg := "OpenAI not configured"
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition-cleanup", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	cleaned, err := openai.CleanupTranscript(preparedStr)
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

	// Find cleaned transcript (already has embeddings stripped) or original
	var transcript string
	var isCleanedVersion bool
	for _, d := range existingDigests {
		if d.Digester == "speech-recognition-cleanup" && d.Status == "completed" && d.Content != nil {
			transcript = *d.Content
			isCleanedVersion = true
			break
		}
	}
	if transcript == "" {
		for _, d := range existingDigests {
			if d.Digester == "speech-recognition" && d.Status == "completed" && d.Content != nil {
				transcript = *d.Content
				isCleanedVersion = false
				break
			}
		}
	}

	if transcript == "" {
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition-summary", Status: DigestStatusCompleted, CreatedAt: now, UpdatedAt: now}}, nil
	}

	// If using raw speech-recognition (not cleaned), strip embeddings to reduce token usage
	if !isCleanedVersion {
		var asrResp vendors.ASRResponse
		if err := json.Unmarshal([]byte(transcript), &asrResp); err == nil {
			preparedResp := prepareASRForLLM(asrResp)
			preparedJSON, _ := json.Marshal(preparedResp)
			transcript = string(preparedJSON)
		}
		// If parsing fails, continue with original (backward compatibility)
	}

	openai := vendors.GetOpenAI()
	if openai == nil {
		errMsg := "OpenAI not configured"
		return []DigestInput{{FilePath: filePath, Digester: "speech-recognition-summary", Status: DigestStatusFailed, Error: &errMsg, CreatedAt: now, UpdatedAt: now}}, nil
	}

	summary, err := openai.SummarizeTranscript(transcript)
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

