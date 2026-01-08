package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/vendors"
)

// SearchResultItem represents a search result
type SearchResultItem struct {
	Path            string            `json:"path"`
	Name            string            `json:"name"`
	IsFolder        bool              `json:"isFolder"`
	Size            *int64            `json:"size,omitempty"`
	MimeType        *string           `json:"mimeType,omitempty"`
	ModifiedAt      string            `json:"modifiedAt"`
	CreatedAt       string            `json:"createdAt"`
	Digests         []db.Digest       `json:"digests"`
	Score           float64           `json:"score"`
	Snippet         string            `json:"snippet"`
	TextPreview     *string           `json:"textPreview,omitempty"`
	ScreenshotSqlar *string           `json:"screenshotSqlar,omitempty"`
	Highlights      map[string]string `json:"highlights,omitempty"`
	MatchContext    *MatchContext     `json:"matchContext,omitempty"`
}

// MatchContext provides context about where the match was found
type MatchContext struct {
	Source     string        `json:"source"` // "digest" or "semantic"
	Snippet    string        `json:"snippet"`
	Terms      []string      `json:"terms"`
	Score      *float64      `json:"score,omitempty"`
	SourceType string        `json:"sourceType,omitempty"` // For semantic matches
	Digest     *DigestInfo   `json:"digest,omitempty"`     // For keyword matches
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
func Search(c *gin.Context) {
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
		typesParam = "keyword,semantic"
	}
	searchTypes := strings.Split(typesParam, ",")
	useKeyword := contains(searchTypes, "keyword")
	useSemantic := contains(searchTypes, "semantic")

	if !useKeyword && !useSemantic {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Invalid types parameter. Use 'keyword', 'semantic', or 'keyword,semantic'",
			"code":  "INVALID_TYPES",
		})
		return
	}

	// Initialize clients
	meiliClient := vendors.GetMeiliClient()
	qdrantClient := vendors.GetQdrantClient()

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
				if len(snippet) > 200 {
					snippet = snippet[:200]
				}
				if formatted, ok := hit.Formatted["content"]; ok && formatted != "" {
					snippet = formatted
					if len(snippet) > 200 {
						snippet = snippet[:200]
					}
				}

				// Build match context for keyword results
				var matchContext *MatchContext
				terms := extractSearchTerms(query)
				matchContext = buildKeywordMatchContext(hit, file, terms)

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
				})
			}
		}
	}

	// Semantic search
	if useSemantic && qdrantClient != nil {
		// Get query embedding
		embedding, err := vendors.EmbedText(query)
		if err != nil {
			log.Error().Err(err).Msg("failed to get query embedding")
		} else {
			semanticResults, err := qdrantClient.Search(embedding, vendors.QdrantSearchOptions{
				Limit:          limit,
				ScoreThreshold: 0.7,
				TypeFilter:     typeFilter,
				PathFilter:     pathFilter,
			})
			if err != nil {
				log.Error().Err(err).Msg("qdrant search failed")
			} else {
				sources = append(sources, "semantic")

				// Deduplicate with keyword results
				existingPaths := make(map[string]bool)
				for _, r := range results {
					existingPaths[r.Path] = true
				}

				for _, hit := range semanticResults {
					if existingPaths[hit.FilePath] {
						continue
					}

					file, err := db.GetFileWithDigests(hit.FilePath)
					if err != nil || file == nil {
						continue
					}

					score := float64(hit.Score)
					results = append(results, SearchResultItem{
						Path:            file.Path,
						Name:            file.Name,
						IsFolder:        file.IsFolder,
						Size:            file.Size,
						MimeType:        file.MimeType,
						ModifiedAt:      file.ModifiedAt,
						CreatedAt:       file.CreatedAt,
						Digests:         file.Digests,
						Score:           float64(hit.Score),
						Snippet:         hit.Text[:min(200, len(hit.Text))],
						TextPreview:     file.TextPreview,
						ScreenshotSqlar: file.ScreenshotSqlar,
						MatchContext: &MatchContext{
							Source:     "semantic",
							Snippet:    hit.Text[:min(300, len(hit.Text))],
							Terms:      extractSearchTerms(query),
							Score:      &score,
							SourceType: hit.SourceType,
						},
					})
				}
			}
		}
	}

	// If no search services available, fall back to database search
	if len(sources) == 0 {
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

// buildKeywordMatchContext creates match context from Meilisearch formatted results
// This matches the Node.js buildDigestMatchContext function
func buildKeywordMatchContext(hit vendors.MeiliHit, file *db.FileWithDigests, terms []string) *MatchContext {
	const highlightTag = "<em>"

	if len(terms) == 0 {
		return nil
	}

	// Digest labels matching Node.js TEXT_SOURCE_LABELS and ADDITIONAL_DIGEST_LABELS
	digestLabels := map[string]string{
		"url-crawl-content":   "Web page content",
		"url-crawl-summary":   "Summary",
		"doc-to-markdown":     "Document content",
		"image-ocr":           "Image text (OCR)",
		"image-captioning":    "Image caption",
		"image-objects":       "Image objects",
		"speech-recognition":  "Speech transcript",
		"tags":                "Tags",
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
func extractSnippetFromFormatted(formattedText string, maxLength int) string {
	const highlightPre = "<em>"
	const highlightPost = "</em>"

	highlightStart := strings.Index(formattedText, highlightPre)
	if highlightStart == -1 {
		if len(formattedText) > maxLength {
			return formattedText[:maxLength]
		}
		return formattedText
	}

	// Extract context around the highlight
	contextRadius := 80
	start := max(0, highlightStart-contextRadius)
	end := min(len(formattedText), highlightStart+contextRadius+100)

	snippet := formattedText[start:end]
	if start > 0 {
		snippet = "..." + snippet
	}
	if end < len(formattedText) {
		snippet = snippet + "..."
	}

	// Trim if still too long, but keep the highlight
	if len(snippet) > maxLength {
		firstHighlight := strings.Index(snippet, highlightPre)
		highlightEnd := strings.Index(snippet[firstHighlight:], highlightPost)
		if firstHighlight != -1 && highlightEnd != -1 {
			minLength := firstHighlight + highlightEnd + len(highlightPost) + 20
			if minLength < maxLength {
				snippet = snippet[:maxLength] + "..."
			} else {
				snippet = snippet[:minLength] + "..."
			}
		} else {
			snippet = snippet[:maxLength] + "..."
		}
	}

	return strings.TrimSpace(snippet)
}
