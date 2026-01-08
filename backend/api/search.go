package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/vendors"
)

var searchLogger = log.GetLogger("ApiSearch")

// SearchResultItem represents a search result
type SearchResultItem struct {
	Path            string         `json:"path"`
	Name            string         `json:"name"`
	IsFolder        bool           `json:"isFolder"`
	Size            *int64         `json:"size,omitempty"`
	MimeType        *string        `json:"mimeType,omitempty"`
	ModifiedAt      string         `json:"modifiedAt"`
	CreatedAt       string         `json:"createdAt"`
	Digests         []db.Digest    `json:"digests"`
	Score           float64        `json:"score"`
	Snippet         string         `json:"snippet"`
	TextPreview     *string        `json:"textPreview,omitempty"`
	ScreenshotSqlar *string        `json:"screenshotSqlar,omitempty"`
	Highlights      map[string]string `json:"highlights,omitempty"`
	MatchContext    *MatchContext  `json:"matchContext,omitempty"`
}

// MatchContext provides context about where the match was found
type MatchContext struct {
	Source     string   `json:"source"` // "digest" or "semantic"
	Snippet    string   `json:"snippet"`
	Terms      []string `json:"terms"`
	Score      *float64 `json:"score,omitempty"`
	SourceType string   `json:"sourceType,omitempty"`
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
func Search(c echo.Context) error {
	query := strings.TrimSpace(c.QueryParam("q"))
	if query == "" {
		return c.JSON(http.StatusBadRequest, map[string]interface{}{
			"error": "Query parameter 'q' is required",
			"code":  "QUERY_REQUIRED",
		})
	}

	if len(query) < 2 {
		return c.JSON(http.StatusBadRequest, map[string]interface{}{
			"error": "Query must be at least 2 characters",
			"code":  "QUERY_TOO_SHORT",
		})
	}

	limit := 20
	if l, err := strconv.Atoi(c.QueryParam("limit")); err == nil && l > 0 && l <= 100 {
		limit = l
	}

	offset := 0
	if o, err := strconv.Atoi(c.QueryParam("offset")); err == nil && o >= 0 {
		offset = o
	}

	typeFilter := c.QueryParam("type")
	pathFilter := c.QueryParam("path")

	// Parse search types
	typesParam := c.QueryParam("types")
	if typesParam == "" {
		typesParam = "keyword,semantic"
	}
	searchTypes := strings.Split(typesParam, ",")
	useKeyword := contains(searchTypes, "keyword")
	useSemantic := contains(searchTypes, "semantic")

	if !useKeyword && !useSemantic {
		return c.JSON(http.StatusBadRequest, map[string]interface{}{
			"error": "Invalid types parameter. Use 'keyword', 'semantic', or 'keyword,semantic'",
			"code":  "INVALID_TYPES",
		})
	}

	// Initialize clients
	meiliClient := vendors.GetMeiliClient()
	qdrantClient := vendors.GetQdrantClient()

	var results []SearchResultItem
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
			searchLogger.Error().Err(err).Msg("meilisearch failed")
		} else {
			sources = append(sources, "keyword")
			total = meiliResults.EstimatedTotalHits

			for _, hit := range meiliResults.Hits {
				file, err := db.GetFileWithDigests(hit.FilePath)
				if err != nil || file == nil {
					continue
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
					Snippet:         hit.Content[:min(200, len(hit.Content))],
					TextPreview:     file.TextPreview,
					ScreenshotSqlar: file.ScreenshotSqlar,
				})
			}
		}
	}

	// Semantic search
	if useSemantic && qdrantClient != nil {
		// Get query embedding
		embedding, err := vendors.EmbedText(query)
		if err != nil {
			searchLogger.Error().Err(err).Msg("failed to get query embedding")
		} else {
			semanticResults, err := qdrantClient.Search(embedding, vendors.QdrantSearchOptions{
				Limit:          limit,
				ScoreThreshold: 0.7,
				TypeFilter:     typeFilter,
				PathFilter:     pathFilter,
			})
			if err != nil {
				searchLogger.Error().Err(err).Msg("qdrant search failed")
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
		searchLogger.Warn().Msg("no search services available, falling back to database search")
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

	return c.JSON(http.StatusOK, response)
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
