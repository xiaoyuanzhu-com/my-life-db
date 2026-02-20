package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/vendors"
)

// RleMask represents an RLE mask for SAM segmentation
type RleMask struct {
	Size   []int `json:"size"`
	Counts []int `json:"counts"`
}

// MatchedObject represents a matched object from image-objects digest
type MatchedObject struct {
	Title string    `json:"title"`
	BBox  []float64 `json:"bbox"`
	Rle   *RleMask  `json:"rle"`
}

// SearchResultItem represents a search result
type SearchResultItem struct {
	Path            string            `json:"path"`
	Name            string            `json:"name"`
	IsFolder        bool              `json:"isFolder"`
	Size            *int64            `json:"size,omitempty"`
	MimeType        *string           `json:"mimeType,omitempty"`
	ModifiedAt      int64             `json:"modifiedAt"`
	CreatedAt       int64             `json:"createdAt"`
	Digests         []db.Digest       `json:"digests"`
	Score           float64           `json:"score"`
	Snippet         string            `json:"snippet"`
	TextPreview     *string           `json:"textPreview,omitempty"`
	ScreenshotSqlar *string           `json:"screenshotSqlar,omitempty"`
	Highlights      map[string]string `json:"highlights,omitempty"`
	MatchContext    *MatchContext     `json:"matchContext,omitempty"`
	MatchedObject   *MatchedObject    `json:"matchedObject,omitempty"`
}

// MatchContext provides context about where the match was found
type MatchContext struct {
	Source     string      `json:"source"` // "digest" or "semantic"
	Snippet    string      `json:"snippet"`
	Terms      []string    `json:"terms"`
	Score      *float64    `json:"score,omitempty"`
	SourceType string      `json:"sourceType,omitempty"` // For semantic matches
	Digest     *DigestInfo `json:"digest,omitempty"`     // For keyword matches
}

// DigestInfo provides digest type and label for match context
type DigestInfo struct {
	Type  string `json:"type"`
	Label string `json:"label"`
}

// SearchResponse represents the search API response
type SearchResponse struct {
	Results    []SearchResultItem `json:"results"`
	Pagination struct {
		Total   int  `json:"total"`
		Limit   int  `json:"limit"`
		Offset  int  `json:"offset"`
		HasMore bool `json:"hasMore"`
	} `json:"pagination"`
	Query   string   `json:"query"`
	Timing  Timing   `json:"timing"`
	Sources []string `json:"sources"`
}

// Timing holds search timing information
type Timing struct {
	TotalMs  int64 `json:"totalMs"`
	SearchMs int64 `json:"searchMs"`
	EnrichMs int64 `json:"enrichMs"`
}

// Search handles GET /api/search
func (h *Handlers) Search(c *gin.Context) {
	query := strings.TrimSpace(c.Query("q"))
	if query == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Query parameter 'q' is required",
			"code":  "QUERY_REQUIRED",
		})
		return
	}

	if len(query) < 2 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Query must be at least 2 characters",
			"code":  "QUERY_TOO_SHORT",
		})
		return
	}

	limit := 20
	if l, err := strconv.Atoi(c.Query("limit")); err == nil && l > 0 && l <= 100 {
		limit = l
	}

	offset := 0
	if o, err := strconv.Atoi(c.Query("offset")); err == nil && o >= 0 {
		offset = o
	}

	typeFilter := c.Query("type")
	pathFilter := c.Query("path")

	// Parse search types
	typesParam := c.Query("types")
	if typesParam == "" {
		typesParam = "keyword"
	}
	searchTypes := strings.Split(typesParam, ",")
	useKeyword := contains(searchTypes, "keyword")

	if !useKeyword {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Invalid types parameter. Use 'keyword'",
			"code":  "INVALID_TYPES",
		})
		return
	}

	// Initialize clients
	meiliClient := vendors.GetMeiliClient()

	results := []SearchResultItem{}
	var total int
	sources := []string{}

	// Keyword search
	if useKeyword && meiliClient != nil {
		meiliResults, err := meiliClient.Search(query, vendors.MeiliSearchOptions{
			Limit:      limit,
			Offset:     offset,
			TypeFilter: typeFilter,
			PathFilter: pathFilter,
		})
		if err != nil {
			log.Error().Err(err).Msg("meilisearch failed")
		} else {
			sources = append(sources, "keyword")
			total = meiliResults.EstimatedTotalHits

			for _, hit := range meiliResults.Hits {
				file, err := db.GetFileWithDigests(hit.FilePath)
				if err != nil || file == nil {
					continue
				}

				// Build highlights from formatted fields
				highlights := make(map[string]string)
				if hit.Formatted != nil {
					for k, v := range hit.Formatted {
						highlights[k] = v
					}
				}

				// Build snippet from formatted content or raw content
				snippet := hit.Content
				snippet = safeSubstring(snippet, 200)
				if formatted, ok := hit.Formatted["content"]; ok && formatted != "" {
					snippet = safeSubstring(formatted, 200)
				}

				// Build match context for keyword results
				var matchContext *MatchContext
				terms := extractSearchTerms(query)
				matchContext = buildKeywordMatchContext(hit, file, terms)

				// For image files, check if we matched on image-objects and include the matched object for highlighting
				var matchedObject *MatchedObject
				if file.MimeType != nil && strings.HasPrefix(*file.MimeType, "image/") {
					matchedObject = findMatchingObject(file, terms)
				}

				results = append(results, SearchResultItem{
					Path:            file.Path,
					Name:            file.Name,
					IsFolder:        file.IsFolder,
					Size:            file.Size,
					MimeType:        file.MimeType,
					ModifiedAt:      file.ModifiedAt,
					CreatedAt:       file.CreatedAt,
					Digests:         file.Digests,
					Score:           1.0,
					Snippet:         snippet,
					TextPreview:     file.TextPreview,
					ScreenshotSqlar: file.ScreenshotSqlar,
					Highlights:      highlights,
					MatchContext:    matchContext,
					MatchedObject:   matchedObject,
				})
			}
		}
	}

	// If no search services available and keyword search was requested, fall back to database search
	if len(sources) == 0 && useKeyword {
		log.Warn().Msg("no search services available, falling back to database search")
		sources = append(sources, "database")

		// Simple LIKE search on file names and text preview
		rows, err := db.GetDB().Query(`
			SELECT path, name, is_folder, size, mime_type, modified_at, created_at, text_preview, screenshot_sqlar
			FROM files
			WHERE (name LIKE '%' || ? || '%' OR text_preview LIKE '%' || ? || '%')
			ORDER BY modified_at DESC
			LIMIT ? OFFSET ?
		`, query, query, limit, offset)

		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var f db.FileRecord
				var isFolder int
				if err := rows.Scan(&f.Path, &f.Name, &isFolder, &f.Size, &f.MimeType, &f.ModifiedAt, &f.CreatedAt, &f.TextPreview, &f.ScreenshotSqlar); err != nil {
					continue
				}
				f.IsFolder = isFolder == 1

				results = append(results, SearchResultItem{
					Path:            f.Path,
					Name:            f.Name,
					IsFolder:        f.IsFolder,
					Size:            f.Size,
					MimeType:        f.MimeType,
					ModifiedAt:      f.ModifiedAt,
					CreatedAt:       f.CreatedAt,
					Digests:         []db.Digest{},
					Score:           0.5,
					Snippet:         "",
					TextPreview:     f.TextPreview,
					ScreenshotSqlar: f.ScreenshotSqlar,
				})
			}
		}
	}

	response := SearchResponse{
		Results: results,
		Query:   query,
		Sources: sources,
		Timing: Timing{
			TotalMs:  0,
			SearchMs: 0,
			EnrichMs: 0,
		},
	}
	response.Pagination.Total = max(total, len(results))
	response.Pagination.Limit = limit
	response.Pagination.Offset = offset
	response.Pagination.HasMore = len(results) >= limit

	c.JSON(http.StatusOK, response)
}

// safeSubstring safely extracts a substring up to maxLen characters (not bytes)
// This handles unicode properly by counting runes instead of bytes
func safeSubstring(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen])
}

func extractSearchTerms(query string) []string {
	terms := strings.Fields(query)
	seen := make(map[string]bool)
	var result []string
	for _, term := range terms {
		term = strings.Trim(term, "\"'")
		if term != "" && !seen[term] {
			seen[term] = true
			result = append(result, term)
		}
	}
	return result
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if strings.TrimSpace(s) == item {
			return true
		}
	}
	return false
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// findMatchingObject finds the first object in image-objects digest that matches any search term
// Returns the object with its bbox and rle for highlighting
func findMatchingObject(file *db.FileWithDigests, terms []string) *MatchedObject {
	if file == nil || len(terms) == 0 {
		return nil
	}

	// Find the image-objects digest
	var objectsDigest *db.Digest
	for i := range file.Digests {
		if file.Digests[i].Digester == "image-objects" && file.Digests[i].Content != nil {
			objectsDigest = &file.Digests[i]
			break
		}
	}

	if objectsDigest == nil || objectsDigest.Content == nil {
		return nil
	}

	// Parse the JSON content
	var data struct {
		Objects []struct {
			Title       string                 `json:"title"`
			Description string                 `json:"description"`
			BBox        []float64              `json:"bbox"`
			Rle         map[string]interface{} `json:"rle"`
		} `json:"objects"`
	}

	if err := json.Unmarshal([]byte(*objectsDigest.Content), &data); err != nil {
		log.Warn().Err(err).Str("filePath", file.Path).Msg("failed to parse image-objects digest for matching")
		return nil
	}

	// Find the first object that matches any search term
	for _, obj := range data.Objects {
		// Build searchable text from title and description
		var searchableText strings.Builder
		if obj.Title != "" {
			searchableText.WriteString(obj.Title)
		}
		if obj.Description != "" {
			if searchableText.Len() > 0 {
				searchableText.WriteString(" ")
			}
			searchableText.WriteString(obj.Description)
		}

		searchText := strings.ToLower(searchableText.String())

		// Check if any term matches (case-insensitive substring matching)
		for _, term := range terms {
			if strings.Contains(searchText, strings.ToLower(term)) {
				// Found a match! Return this object
				var rle *RleMask
				if obj.Rle != nil {
					// Convert the map to RleMask
					if size, ok := obj.Rle["size"].([]interface{}); ok {
						if counts, ok := obj.Rle["counts"].([]interface{}); ok {
							sizeInts := make([]int, len(size))
							for i, v := range size {
								if fv, ok := v.(float64); ok {
									sizeInts[i] = int(fv)
								}
							}
							countsInts := make([]int, len(counts))
							for i, v := range counts {
								if fv, ok := v.(float64); ok {
									countsInts[i] = int(fv)
								}
							}
							rle = &RleMask{
								Size:   sizeInts,
								Counts: countsInts,
							}
						}
					}
				}

				return &MatchedObject{
					Title: obj.Title,
					BBox:  obj.BBox,
					Rle:   rle,
				}
			}
		}
	}

	return nil
}

// buildKeywordMatchContext creates match context from Meilisearch formatted results
// This matches the Node.js buildDigestMatchContext function
func buildKeywordMatchContext(hit vendors.MeiliHit, file *db.FileWithDigests, terms []string) *MatchContext {
	const highlightTag = "<em>"

	if len(terms) == 0 {
		return nil
	}

	// Digest labels matching Node.js TEXT_SOURCE_LABELS and ADDITIONAL_DIGEST_LABELS
	digestLabels := map[string]string{
		"url-crawl-content":  "Web page content",
		"url-crawl-summary":  "Summary",
		"doc-to-markdown":    "Document content",
		"image-ocr":          "Image text (OCR)",
		"image-captioning":   "Image caption",
		"image-objects":      "Image objects",
		"speech-recognition": "Speech transcript",
		"tags":               "Tags",
	}

	// Field configuration matching Node.js DIGEST_FIELD_CONFIG
	type fieldConfig struct {
		field         string
		digesterTypes []string
		label         string
	}

	fieldConfigs := []fieldConfig{
		{"filePath", []string{}, "File path"},
		{"summary", []string{"url-crawl-summary"}, "Summary"},
		{"tags", []string{"tags"}, "Tags"},
		{"content", []string{"url-crawl-content", "doc-to-markdown", "image-ocr", "image-captioning", "image-objects", "speech-recognition"}, "File content"},
	}

	// Check each field in priority order
	for _, config := range fieldConfigs {
		formattedValue := hit.Formatted[config.field]
		if !hasHighlight(formattedValue, highlightTag) {
			continue
		}

		snippet := extractSnippetFromFormatted(formattedValue, 200)
		if config.field == "content" {
			snippet = extractSnippetFromFormatted(formattedValue, 300)
		}
		if strings.TrimSpace(snippet) == "" {
			continue
		}

		// Determine the source type label
		sourceType := config.label

		// For fields with associated digesters, try to find which digest matched
		if len(config.digesterTypes) > 0 {
			// Find which digest actually contains the matched text
			for _, digesterType := range config.digesterTypes {
				var matchedDigest *db.Digest
				for i := range file.Digests {
					if file.Digests[i].Digester == digesterType && file.Digests[i].Content != nil {
						matchedDigest = &file.Digests[i]
						break
					}
				}

				if matchedDigest != nil && matchedDigest.Content != nil {
					// Check if any term matches in this digest's content
					contentLower := strings.ToLower(*matchedDigest.Content)
					for _, term := range terms {
						if strings.Contains(contentLower, strings.ToLower(term)) {
							// Use the digest-specific label if available
							if label, ok := digestLabels[digesterType]; ok {
								sourceType = label
							}
							goto found
						}
					}
				}
			}
		}

	found:
		return &MatchContext{
			Source:  "digest",
			Snippet: snippet,
			Terms:   terms,
			Digest: &DigestInfo{
				Type:  config.field,
				Label: sourceType,
			},
		}
	}

	return nil
}

// hasHighlight checks if a string contains highlight tags
func hasHighlight(text string, highlightTag string) bool {
	return text != "" && strings.Contains(text, highlightTag)
}

// extractSnippetFromFormatted extracts a snippet around the highlight
// Uses rune-based operations for proper unicode/multilingual support
func extractSnippetFromFormatted(formattedText string, maxLength int) string {
	const highlightPre = "<em>"
	const highlightPost = "</em>"

	highlightStart := strings.Index(formattedText, highlightPre)
	if highlightStart == -1 {
		return safeSubstring(formattedText, maxLength)
	}

	// Convert to runes for proper unicode handling
	runes := []rune(formattedText)

	// Find the rune position of the highlight start by counting runes up to the byte position
	highlightRuneStart := 0
	byteCount := 0
	for i := range runes {
		if byteCount >= highlightStart {
			highlightRuneStart = i
			break
		}
		byteCount += len(string(runes[i]))
	}

	// Extract context around the highlight (in runes)
	contextRadius := 80
	start := max(0, highlightRuneStart-contextRadius)
	end := min(len(runes), highlightRuneStart+contextRadius+100)

	snippet := string(runes[start:end])
	if start > 0 {
		snippet = "..." + snippet
	}
	if end < len(runes) {
		snippet = snippet + "..."
	}

	// Trim if still too long, but keep the highlight
	snippetRunes := []rune(snippet)
	if len(snippetRunes) > maxLength {
		// Find highlight in the snippet
		snippetHighlightStart := strings.Index(snippet, highlightPre)
		if snippetHighlightStart != -1 {
			// Find the end of the complete highlight tag
			highlightEndBytePos := strings.Index(snippet[snippetHighlightStart:], highlightPost)
			if highlightEndBytePos != -1 {
				// Convert highlight end byte position (relative to highlightStart) to rune position
				highlightEndRunePos := 0
				for i := range snippetRunes {
					runeBytePos := len(string(snippetRunes[:i]))
					if runeBytePos >= snippetHighlightStart+highlightEndBytePos+len(highlightPost) {
						highlightEndRunePos = i
						break
					}
				}
				if highlightEndRunePos == 0 {
					highlightEndRunePos = len(snippetRunes)
				}

				// Keep at least 20 runes after the highlight, but don't exceed maxLength
				minLength := min(highlightEndRunePos+20, len(snippetRunes))
				if minLength <= maxLength {
					snippet = string(snippetRunes[:maxLength]) + "..."
				} else {
					snippet = string(snippetRunes[:minLength]) + "..."
				}
			} else {
				snippet = string(snippetRunes[:maxLength]) + "..."
			}
		} else {
			snippet = string(snippetRunes[:maxLength]) + "..."
		}
	}

	return strings.TrimSpace(snippet)
}
