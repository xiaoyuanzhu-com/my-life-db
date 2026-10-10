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
// Source is "keyword" for filename/path hits.
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

// Search handles GET /api/data/search (filename/path only).
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

	searchStart := time.Now()
	files, hitsTotal, err := h.server.IndexDB().SearchPaths(c.Request.Context(), query, db.PathSearchOptions{
		Limit: limit, Offset: offset, TypeFilter: typeFilter, PathFilter: pathFilter,
	})
	searchMs = time.Since(searchStart).Milliseconds()
	if err != nil {
		log.Error().Err(err).Msg("path search failed")
		RespondCoded(c, http.StatusInternalServerError, "SEARCH_FAILED", "File search failed")
		return
	}
	sources = append(sources, "keyword")
	total = hitsTotal
	terms := extractSearchTerms(query)
	for _, file := range files {
		results = append(results, SearchResultItem{
			Path: file.Path, Name: file.Name, IsFolder: file.IsFolder,
			Size: file.Size, MimeType: file.MimeType, ModifiedAt: file.ModifiedAt,
			CreatedAt: file.CreatedAt, Score: 1, Snippet: file.Path,
			TextPreview:  file.TextPreview,
			MatchContext: &MatchContext{Source: "keyword", Snippet: file.Path, Terms: terms, Label: "File path"},
		})
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
