package vendors

import (
	"sync"

	"github.com/meilisearch/meilisearch-go"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var (
	meiliClient     *MeiliClient
	meiliClientOnce sync.Once
	meiliLogger     = log.GetLogger("Meilisearch")
)

// MeiliClient wraps the Meilisearch client
type MeiliClient struct {
	client   meilisearch.ServiceManager
	index    meilisearch.IndexManager
	indexUID string
}

// MeiliSearchOptions holds search options
type MeiliSearchOptions struct {
	Limit      int
	Offset     int
	TypeFilter string
	PathFilter string
}

// MeiliSearchResult represents a search result
type MeiliSearchResult struct {
	Hits               []MeiliHit
	EstimatedTotalHits int
	Limit              int
	Offset             int
	Query              string
}

// MeiliHit represents a single search hit
type MeiliHit struct {
	DocumentID string
	FilePath   string
	MimeType   string
	Content    string
	Summary    string
	Tags       string
	Formatted  map[string]string
}

// GetMeiliClient returns the singleton Meilisearch client
func GetMeiliClient() *MeiliClient {
	meiliClientOnce.Do(func() {
		cfg := config.Get()
		if cfg.MeiliHost == "" {
			meiliLogger.Warn().Msg("MEILI_HOST not configured, Meilisearch disabled")
			return
		}

		client := meilisearch.New(cfg.MeiliHost, meilisearch.WithAPIKey(cfg.MeiliAPIKey))

		// Verify connection
		if _, err := client.Health(); err != nil {
			meiliLogger.Error().Err(err).Msg("failed to connect to Meilisearch")
			return
		}

		index := client.Index(cfg.MeiliIndex)

		meiliClient = &MeiliClient{
			client:   client,
			index:    index,
			indexUID: cfg.MeiliIndex,
		}

		meiliLogger.Info().Str("host", cfg.MeiliHost).Str("index", cfg.MeiliIndex).Msg("Meilisearch initialized")
	})

	return meiliClient
}

// Search performs a search query
func (m *MeiliClient) Search(query string, opts MeiliSearchOptions) (*MeiliSearchResult, error) {
	if m == nil {
		return nil, nil
	}

	// Build filter
	var filters []string
	if opts.TypeFilter != "" {
		filters = append(filters, "mimeType STARTS WITH \""+escapeFilter(opts.TypeFilter)+"\"")
	}
	if opts.PathFilter != "" {
		filters = append(filters, "filePath STARTS WITH \""+escapeFilter(opts.PathFilter)+"\"")
	}

	filter := ""
	if len(filters) > 0 {
		filter = filters[0]
		for _, f := range filters[1:] {
			filter += " AND " + f
		}
	}

	searchReq := &meilisearch.SearchRequest{
		Limit:                 int64(opts.Limit),
		Offset:                int64(opts.Offset),
		AttributesToHighlight: []string{"content", "summary", "tags", "filePath"},
		AttributesToCrop:      []string{"content"},
		CropLength:            200,
		MatchingStrategy:      "all",
	}

	if filter != "" {
		searchReq.Filter = filter
	}

	resp, err := m.index.Search(query, searchReq)
	if err != nil {
		return nil, err
	}

	result := &MeiliSearchResult{
		EstimatedTotalHits: int(resp.EstimatedTotalHits),
		Limit:              opts.Limit,
		Offset:             opts.Offset,
		Query:              query,
	}

	for _, hit := range resp.Hits {
		h := hit.(map[string]interface{})

		meiliHit := MeiliHit{
			DocumentID: getString(h, "documentId"),
			FilePath:   getString(h, "filePath"),
			MimeType:   getString(h, "mimeType"),
			Content:    getString(h, "content"),
			Summary:    getString(h, "summary"),
			Tags:       getString(h, "tags"),
		}

		// Get formatted (highlighted) fields
		if formatted, ok := h["_formatted"].(map[string]interface{}); ok {
			meiliHit.Formatted = make(map[string]string)
			for k, v := range formatted {
				if s, ok := v.(string); ok {
					meiliHit.Formatted[k] = s
				}
			}
		}

		result.Hits = append(result.Hits, meiliHit)
	}

	return result, nil
}

// IndexDocument indexes a document
func (m *MeiliClient) IndexDocument(doc map[string]interface{}) error {
	if m == nil {
		return nil
	}

	_, err := m.index.AddDocuments([]map[string]interface{}{doc}, "documentId")
	return err
}

// DeleteDocument removes a document
func (m *MeiliClient) DeleteDocument(documentID string) error {
	if m == nil {
		return nil
	}

	_, err := m.index.DeleteDocument(documentID)
	return err
}

// Helper functions

func escapeFilter(value string) string {
	// Escape backslashes and quotes
	result := ""
	for _, c := range value {
		switch c {
		case '\\':
			result += "\\\\"
		case '"':
			result += "\\\""
		default:
			result += string(c)
		}
	}
	return result
}

func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// GetMeilisearch returns the Meilisearch client (wrapper for digest workers)
func GetMeilisearch() *MeiliClient {
	return GetMeiliClient()
}

// IndexDocumentSimple indexes a document with path, name, and content (simplified interface)
func (m *MeiliClient) IndexDocumentSimple(path, name, content string) error {
	if m == nil {
		return nil
	}

	doc := map[string]interface{}{
		"documentId": path,
		"filePath":   path,
		"name":       name,
		"content":    content,
	}

	_, err := m.index.AddDocuments([]map[string]interface{}{doc}, "documentId")
	return err
}
