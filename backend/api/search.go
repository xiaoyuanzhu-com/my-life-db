package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
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
	Path          string            `json:"path"`
	Name          string            `json:"name"`
	IsFolder      bool              `json:"isFolder"`
	Size          *int64            `json:"size,omitempty"`
	MimeType      *string           `json:"mimeType,omitempty"`
	ModifiedAt    int64             `json:"modifiedAt"`
	CreatedAt     int64             `json:"createdAt"`
	Digests       []db.Digest       `json:"digests"`
	Score         float64           `json:"score"`
	Snippet       string            `json:"snippet"`
	TextPreview   *string           `json:"textPreview,omitempty"`
	PreviewSqlar  *string           `json:"previewSqlar,omitempty"`
	PreviewStatus *string           `json:"previewStatus,omitempty"`
	Highlights    map[string]string `json:"highlights,omitempty"`
	MatchContext  *MatchContext     `json:"matchContext,omitempty"`
	MatchedObject *MatchedObject    `json:"matchedObject,omitempty"`
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
		RespondCoded(c, http.StatusBadRequest, "SEARCH_QUERY_REQUIRED", "Query parameter 'q' is required")
		return
	}

	if len(query) < 2 {
		RespondCoded(c, http.StatusBadRequest, "SEARCH_QUERY_TOO_SHORT", "Query must be at least 2 characters")
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
		RespondCoded(c, http.StatusBadRequest, "SEARCH_INVALID_TYPES", "Invalid types parameter")
		return
	}

	results := []SearchResultItem{}
	var total int
	sources := []string{}

	// Keyword search via FTS5
	hits, hitsTotal, err := db.SearchFTS(query, db.FTSSearchOptions{
		Limit:      limit,
		Offset:     offset,
		TypeFilter: typeFilter,
		PathFilter: pathFilter,
	})
	if err != nil {
		log.Error().Err(err).Msg("fts5 search failed")
	} else {
		sources = append(sources, "keyword")
		total = hitsTotal

		terms := extractSearchTerms(query)
		for _, hit := range hits {
			file, err := h.server.DB().GetFileWithDigests(hit.FilePath)
			if err != nil || file == nil {
				continue
			}

			// Highlights map mirrors the old meili shape so the frontend
			// can render `<em>` markup on file_path / content.
			highlights := map[string]string{}
			if hit.FilePathHL != "" {
				highlights["filePath"] = hit.FilePathHL
			}
			if hit.Snippet != "" {
				highlights["content"] = hit.Snippet
			}

			snippet := safeSubstring(stripEm(hit.Snippet), 200)

			matchContext := buildKeywordMatchContext(hit, file, terms)

			var matchedObject *MatchedObject
			if file.MimeType != nil && strings.HasPrefix(*file.MimeType, "image/") {
				matchedObject = findMatchingObject(file, terms)
			}

			results = append(results, SearchResultItem{
				Path:          file.Path,
				Name:          file.Name,
				IsFolder:      file.IsFolder,
				Size:          file.Size,
				MimeType:      file.MimeType,
				ModifiedAt:    file.ModifiedAt,
				CreatedAt:     file.CreatedAt,
				Digests:       file.Digests,
				Score:         -hit.Score, // bm25 is negative-better; flip for "higher is better" UX
				Snippet:       snippet,
				TextPreview:   file.TextPreview,
				PreviewSqlar:  file.PreviewSqlar,
				PreviewStatus: file.PreviewStatus,
				Highlights:    highlights,
				MatchContext:  matchContext,
				MatchedObject: matchedObject,
			})
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
	response.Pagination.HasMore = offset+len(results) < total

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

// stripEm removes <em>...</em> markup so the same string can be reused as a
// plain-text snippet. The frontend's `match-context.tsx` renders the
// highlighted version separately via the Highlights map.
func stripEm(s string) string {
	r := strings.NewReplacer("<em>", "", "</em>", "")
	return r.Replace(s)
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

// buildKeywordMatchContext creates a MatchContext for an FTS5 hit. FTS5
// indexes one content column that already concatenates the file path and
// the file's text content, so we can't deduce *which* field matched purely
// from the hit. Instead we:
//
//  1. If the path was highlighted, label the match as "File path".
//  2. Otherwise scan the file's digests for the search terms and label by
//     which digester contributed the matched text (Summary, OCR, etc).
//  3. Fall back to a generic "File content" label.
func buildKeywordMatchContext(hit db.FTSHit, file *db.FileWithDigests, terms []string) *MatchContext {
	if len(terms) == 0 {
		return nil
	}

	// File-path match — happens when the user searches for a filename.
	if strings.Contains(hit.FilePathHL, "<em>") {
		snippet := hit.FilePathHL
		if !hit.HasContentHit {
			return &MatchContext{
				Source:  "digest",
				Snippet: snippet,
				Terms:   terms,
				Digest: &DigestInfo{
					Type:  "filePath",
					Label: "File path",
				},
			}
		}
		// If both path and content matched, prefer the content match below.
	}

	if !hit.HasContentHit {
		return nil
	}

	// Digest labels matching the old TEXT_SOURCE_LABELS / ADDITIONAL_DIGEST_LABELS.
	digestLabels := map[string]string{
		"url-crawl-summary": "Summary",
		"doc-to-markdown":   "Document content",
		"image-objects":     "Image objects",
		"tags":              "Tags",
	}

	// Probe digesters in priority order. The order roughly mirrors the
	// fieldConfigs the old code walked.
	priority := []string{
		"url-crawl-summary",
		"tags",
		"doc-to-markdown",
		"image-objects",
	}

	for _, digesterType := range priority {
		var digest *db.Digest
		for i := range file.Digests {
			if file.Digests[i].Digester == digesterType && file.Digests[i].Content != nil {
				digest = &file.Digests[i]
				break
			}
		}
		if digest == nil || digest.Content == nil {
			continue
		}
		contentLower := strings.ToLower(*digest.Content)
		for _, term := range terms {
			if strings.Contains(contentLower, strings.ToLower(term)) {
				return &MatchContext{
					Source:  "digest",
					Snippet: hit.Snippet,
					Terms:   terms,
					Digest: &DigestInfo{
						Type:  "content",
						Label: digestLabels[digesterType],
					},
				}
			}
		}
	}

	// Generic fallback — content matched but we couldn't attribute it to a
	// specific digester (e.g., the file is plain text indexed verbatim).
	return &MatchContext{
		Source:  "digest",
		Snippet: hit.Snippet,
		Terms:   terms,
		Digest: &DigestInfo{
			Type:  "content",
			Label: "File content",
		},
	}
}
