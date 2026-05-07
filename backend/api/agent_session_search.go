package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SessionSearchResponse is the JSON shape returned by SearchAgentSessions.
type SessionSearchResponse struct {
	Results    []map[string]any `json:"results"`
	Pagination struct {
		Total   int  `json:"total"`
		Limit   int  `json:"limit"`
		Offset  int  `json:"offset"`
		HasMore bool `json:"hasMore"`
	} `json:"pagination"`
	Query string `json:"query"`
}

// SearchAgentSessions handles GET /api/agent/sessions/search.
//
// The session-text FTS index lives on the index DB; session metadata
// (title, updated_at) lives on the app DB. We do the FTS query first, then
// batch-fetch the corresponding session rows for enrichment.
func (h *Handlers) SearchAgentSessions(c *gin.Context) {
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

	hits, total, err := h.server.IndexDB().SearchAgentSessionsFTS(query, db.AgentSessionFTSSearchOptions{
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		log.Error().Err(err).Msg("session fts search failed")
		RespondCoded(c, http.StatusInternalServerError, "SEARCH_FAILED", "Session search failed")
		return
	}

	results := make([]map[string]any, 0, len(hits))
	for _, hit := range hits {
		// Enrich with session metadata. A missing session means the indexer
		// hasn't yet swept the deletion through — skip silently rather than
		// returning a half-populated row.
		sess, err := h.server.AppDB().GetAgentSession(hit.SessionID)
		if err != nil || sess == nil {
			continue
		}
		results = append(results, map[string]any{
			"sessionId": hit.SessionID,
			"title":     sess.Title,
			"snippet":   hit.Snippet,
			"score":     -hit.Score, // bm25 is negative-better; flip for "higher is better" UX
			"updatedAt": sess.UpdatedAt,
			"agentType": sess.AgentType,
		})
	}

	resp := SessionSearchResponse{
		Results: results,
		Query:   query,
	}
	resp.Pagination.Total = total
	resp.Pagination.Limit = limit
	resp.Pagination.Offset = offset
	resp.Pagination.HasMore = offset+len(results) < total

	c.JSON(http.StatusOK, resp)
}
