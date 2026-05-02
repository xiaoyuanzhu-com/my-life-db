package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SearchResultItem represents a search result
type SearchResultItem struct {
	Path          string            `json:"path"`
	Name          string            `json:"name"`
	IsFolder      bool              `json:"isFolder"`
	Size          *int64            `json:"size,omitempty"`
	MimeType      *string           `json:"mimeType,omitempty"`
	ModifiedAt    int64             `json:"modifiedAt"`
	CreatedAt     int64             `json:"createdAt"`
	Score         float64           `json:"score"`
	Snippet       string            `json:"snippet"`
	TextPreview   *string           `json:"textPreview,omitempty"`
	PreviewSqlar  *string           `json:"previewSqlar,omitempty"`
	PreviewStatus *string           `json:"previewStatus,omitempty"`
	Highlights    map[string]string `json:"highlights,omitempty"`
	MatchContext  *MatchContext     `json:"matchContext,omitempty"`
}

// MatchContext provides context about where the match was found.
// Source is "keyword" for FTS5 keyword hits.
type MatchContext struct {
	Source  string   `json:"source"`
	Snippet string   `json:"snippet"`
	Terms   []string `json:"terms"`
	Label   string   `json:"label"` // "File path" or "File content"
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

	totalStart := time.Now()
	var searchMs, enrichMs int64

	// Keyword search via FTS5
	searchStart := time.Now()
	hits, hitsTotal, err := h.server.IndexDB().SearchFTS(query, db.FTSSearchOptions{
		Limit:      limit,
		Offset:     offset,
		TypeFilter: typeFilter,
		PathFilter: pathFilter,
	})
	searchMs = time.Since(searchStart).Milliseconds()
	if err != nil {
		log.Error().Err(err).Msg("fts5 search failed")
	} else {
		sources = append(sources, "keyword")
		total = hitsTotal

		enrichStart := time.Now()
		terms := extractSearchTerms(query)

		// Batch enrichment: gather all hit paths once, then issue one query
		// per data source instead of multiple queries per hit.
		paths := make([]string, 0, len(hits))
		for _, hit := range hits {
			paths = append(paths, hit.FilePath)
		}

		filesByPath, err := h.server.IndexDB().GetFilesByPaths(paths)
		if err != nil {
			log.Error().Err(err).Msg("batch fetch files failed")
			filesByPath = map[string]*db.FileRecord{}
		}
		pinnedSet, err := h.server.AppDB().GetPinnedSet(paths)
		if err != nil {
			log.Error().Err(err).Msg("batch fetch pins failed")
			pinnedSet = map[string]bool{}
		}
		_ = pinnedSet // currently unused in response shape; reserved for future enrichment

		for _, hit := range hits {
			file := filesByPath[hit.FilePath]
			if file == nil {
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

			matchContext := buildKeywordMatchContext(hit, terms)

			results = append(results, SearchResultItem{
				Path:          file.Path,
				Name:          file.Name,
				IsFolder:      file.IsFolder,
				Size:          file.Size,
				MimeType:      file.MimeType,
				ModifiedAt:    file.ModifiedAt,
				CreatedAt:     file.CreatedAt,
				Score:         -hit.Score, // bm25 is negative-better; flip for "higher is better" UX
				Snippet:       snippet,
				TextPreview:   file.TextPreview,
				PreviewSqlar:  file.PreviewSqlar,
				PreviewStatus: file.PreviewStatus,
				Highlights:    highlights,
				MatchContext:  matchContext,
			})
		}
		enrichMs = time.Since(enrichStart).Milliseconds()
	}

	response := SearchResponse{
		Results: results,
		Query:   query,
		Sources: sources,
		Timing: Timing{
			TotalMs:  time.Since(totalStart).Milliseconds(),
			SearchMs: searchMs,
			EnrichMs: enrichMs,
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

// buildKeywordMatchContext creates a MatchContext for an FTS5 hit. Since
// FTS5 indexes a single content column that concatenates the file path
// and the file's text content, the hit itself tells us which side
// matched: if the FilePathHL contains <em> markers and there's no
// content hit, the match was on the path; otherwise it was on the
// content.
func buildKeywordMatchContext(hit db.FTSHit, terms []string) *MatchContext {
	if len(terms) == 0 {
		return nil
	}

	pathMatched := strings.Contains(hit.FilePathHL, "<em>")

	if pathMatched && !hit.HasContentHit {
		return &MatchContext{
			Source:  "keyword",
			Snippet: hit.FilePathHL,
			Terms:   terms,
			Label:   "File path",
		}
	}

	if !hit.HasContentHit {
		return nil
	}

	return &MatchContext{
		Source:  "keyword",
		Snippet: hit.Snippet,
		Terms:   terms,
		Label:   "File content",
	}
}
