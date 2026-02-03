package vendors

import (
	"context"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"github.com/qdrant/go-client/qdrant"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var (
	qdrantClient     *QdrantClient
	qdrantClientOnce sync.Once
)

// QdrantClient wraps the Qdrant client
type QdrantClient struct {
	client     *qdrant.Client
	collection string
}

// QdrantSearchOptions holds search options
type QdrantSearchOptions struct {
	Limit          int
	ScoreThreshold float32
	TypeFilter     string
	PathFilter     string
}

// QdrantSearchResult represents a search result
type QdrantSearchResult struct {
	ID         string
	Score      float32
	FilePath   string
	Text       string
	SourceType string
}

// GetQdrantClient returns the singleton Qdrant client
func GetQdrantClient() *QdrantClient {
	qdrantClientOnce.Do(func() {
		// Load settings from database first, fall back to env vars
		settings, err := db.LoadUserSettings()
		if err != nil {
			log.Error().Err(err).Msg("failed to load user settings for Qdrant")
			return
		}

		qdrantHost := ""
		if settings.Vendors != nil && settings.Vendors.Qdrant != nil {
			qdrantHost = settings.Vendors.Qdrant.Host
		}

		// If not in DB, fall back to env var
		if qdrantHost == "" {
			cfg := config.Get()
			qdrantHost = cfg.QdrantHost
		}

		if qdrantHost == "" {
			log.Warn().Msg("Qdrant host not configured, Qdrant disabled")
			return
		}

		// Parse the URL to extract host and port
		// The Qdrant Go client expects Host (without protocol) and Port separately
		qdrantHost = strings.TrimSuffix(qdrantHost, "/")

		// Parse URL to extract host and port
		parsedURL, err := url.Parse(qdrantHost)
		if err != nil {
			log.Error().Err(err).Str("url", qdrantHost).Msg("failed to parse Qdrant URL")
			return
		}

		// Extract hostname and port
		hostname := parsedURL.Hostname()
		port := parsedURL.Port()
		if port == "" {
			// Default to gRPC port 6334 if no port specified
			port = "6334"
		}
		portNum, err := strconv.Atoi(port)
		if err != nil {
			log.Error().Err(err).Str("port", port).Msg("invalid Qdrant port")
			return
		}

		// Use API key from config (typically from env var)
		cfg := config.Get()
		useTLS := parsedURL.Scheme == "https"

		client, err := qdrant.NewClient(&qdrant.Config{
			Host:   hostname,
			Port:   portNum,
			APIKey: cfg.QdrantAPIKey,
			UseTLS: useTLS,
		})
		if err != nil {
			log.Error().Err(err).Msg("failed to create Qdrant client")
			return
		}

		// Ensure collection exists
		exists, err := client.CollectionExists(context.Background(), cfg.QdrantCollection)
		if err != nil {
			log.Error().Err(err).Msg("failed to check collection")
			return
		}

		if !exists {
			// Create collection with default config
			err = client.CreateCollection(context.Background(), &qdrant.CreateCollection{
				CollectionName: cfg.QdrantCollection,
				VectorsConfig: qdrant.NewVectorsConfig(&qdrant.VectorParams{
					Size:     1024, // HAID Qwen/Qwen3-Embedding-0.6B dimension
					Distance: qdrant.Distance_Cosine,
				}),
			})
			if err != nil {
				log.Error().Err(err).Msg("failed to create collection")
				return
			}
			log.Info().Str("collection", cfg.QdrantCollection).Msg("created Qdrant collection")
		}

		qdrantClient = &QdrantClient{
			client:     client,
			collection: cfg.QdrantCollection,
		}

		log.Info().Str("host", hostname).Int("port", portNum).Str("collection", cfg.QdrantCollection).Msg("Qdrant initialized")
	})

	return qdrantClient
}

// Search performs a vector search
func (q *QdrantClient) Search(vector []float32, opts QdrantSearchOptions) ([]QdrantSearchResult, error) {
	if q == nil {
		return nil, nil
	}

	ctx := context.Background()

	// Build filter
	var filter *qdrant.Filter
	var conditions []*qdrant.Condition

	if opts.TypeFilter != "" {
		conditions = append(conditions, &qdrant.Condition{
			ConditionOneOf: &qdrant.Condition_Field{
				Field: &qdrant.FieldCondition{
					Key: "mimeType",
					Match: &qdrant.Match{
						MatchValue: &qdrant.Match_Keyword{
							Keyword: opts.TypeFilter,
						},
					},
				},
			},
		})
	}

	if opts.PathFilter != "" {
		conditions = append(conditions, &qdrant.Condition{
			ConditionOneOf: &qdrant.Condition_Field{
				Field: &qdrant.FieldCondition{
					Key: "filePath",
					Match: &qdrant.Match{
						MatchValue: &qdrant.Match_Text{
							Text: opts.PathFilter,
						},
					},
				},
			},
		})
	}

	if len(conditions) > 0 {
		filter = &qdrant.Filter{
			Must: conditions,
		}
	}

	limit := uint64(opts.Limit)
	searchResult, err := q.client.Query(ctx, &qdrant.QueryPoints{
		CollectionName: q.collection,
		Query:          qdrant.NewQueryDense(vector),
		Limit:          &limit,
		ScoreThreshold: &opts.ScoreThreshold,
		WithPayload:    qdrant.NewWithPayloadInclude("filePath", "text", "sourceType", "mimeType"),
		Filter:         filter,
	})
	if err != nil {
		return nil, err
	}

	var results []QdrantSearchResult
	for _, point := range searchResult {
		result := QdrantSearchResult{
			ID:    point.Id.GetUuid(),
			Score: point.Score,
		}

		if payload := point.Payload; payload != nil {
			if v, ok := payload["filePath"]; ok {
				result.FilePath = v.GetStringValue()
			}
			if v, ok := payload["text"]; ok {
				result.Text = v.GetStringValue()
			}
			if v, ok := payload["sourceType"]; ok {
				result.SourceType = v.GetStringValue()
			}
		}

		results = append(results, result)
	}

	return results, nil
}

// Upsert adds or updates a point
func (q *QdrantClient) Upsert(id string, vector []float32, payload map[string]interface{}) error {
	if q == nil {
		return nil
	}

	ctx := context.Background()

	// Convert payload to Qdrant format
	qdrantPayload := make(map[string]*qdrant.Value)
	for k, v := range payload {
		switch val := v.(type) {
		case string:
			qdrantPayload[k] = &qdrant.Value{
				Kind: &qdrant.Value_StringValue{StringValue: val},
			}
		case int:
			qdrantPayload[k] = &qdrant.Value{
				Kind: &qdrant.Value_IntegerValue{IntegerValue: int64(val)},
			}
		case float64:
			qdrantPayload[k] = &qdrant.Value{
				Kind: &qdrant.Value_DoubleValue{DoubleValue: val},
			}
		}
	}

	_, err := q.client.Upsert(ctx, &qdrant.UpsertPoints{
		CollectionName: q.collection,
		Points: []*qdrant.PointStruct{
			{
				Id:      qdrant.NewIDUUID(id),
				Vectors: qdrant.NewVectorsDense(vector),
				Payload: qdrantPayload,
			},
		},
	})

	return err
}

// Delete removes a point
func (q *QdrantClient) Delete(id string) error {
	if q == nil {
		return nil
	}

	ctx := context.Background()
	_, err := q.client.Delete(ctx, &qdrant.DeletePoints{
		CollectionName: q.collection,
		Points: &qdrant.PointsSelector{
			PointsSelectorOneOf: &qdrant.PointsSelector_Points{
				Points: &qdrant.PointsIdsList{
					Ids: []*qdrant.PointId{qdrant.NewIDUUID(id)},
				},
			},
		},
	})

	return err
}

// GetQdrant returns the Qdrant client (wrapper for digest workers)
func GetQdrant() *QdrantClient {
	return GetQdrantClient()
}

// UpsertPoint is a wrapper for Upsert with simplified interface
func (q *QdrantClient) UpsertPoint(id string, vector []float32, payload map[string]interface{}) error {
	return q.Upsert(id, vector, payload)
}

// SetPayload updates payload fields for points matching a filter.
// Uses SetPayload API - only specified fields are modified, vector and other fields preserved.
// This is more efficient than re-upserting (which requires the vector).
func (q *QdrantClient) SetPayload(pointIDs []string, payload map[string]interface{}) error {
	if q == nil || len(pointIDs) == 0 {
		return nil
	}

	ctx := context.Background()

	// Convert payload to Qdrant format
	qdrantPayload := make(map[string]*qdrant.Value)
	for k, v := range payload {
		switch val := v.(type) {
		case string:
			qdrantPayload[k] = &qdrant.Value{
				Kind: &qdrant.Value_StringValue{StringValue: val},
			}
		case int:
			qdrantPayload[k] = &qdrant.Value{
				Kind: &qdrant.Value_IntegerValue{IntegerValue: int64(val)},
			}
		case float64:
			qdrantPayload[k] = &qdrant.Value{
				Kind: &qdrant.Value_DoubleValue{DoubleValue: val},
			}
		}
	}

	// Convert string IDs to PointId
	ids := make([]*qdrant.PointId, len(pointIDs))
	for i, id := range pointIDs {
		ids[i] = qdrant.NewIDUUID(id)
	}

	_, err := q.client.SetPayload(ctx, &qdrant.SetPayloadPoints{
		CollectionName: q.collection,
		Payload:        qdrantPayload,
		PointsSelector: &qdrant.PointsSelector{
			PointsSelectorOneOf: &qdrant.PointsSelector_Points{
				Points: &qdrant.PointsIdsList{
					Ids: ids,
				},
			},
		},
	})

	if err != nil {
		log.Warn().
			Err(err).
			Int("count", len(pointIDs)).
			Msg("failed to set payload in Qdrant")
	}
	return err
}

// SetPayloadByFilter updates payload fields for all points matching a filter.
// Useful for updating filePath when we don't know the point IDs.
func (q *QdrantClient) SetPayloadByFilter(filter *qdrant.Filter, payload map[string]interface{}) error {
	if q == nil || filter == nil {
		return nil
	}

	ctx := context.Background()

	// Convert payload to Qdrant format
	qdrantPayload := make(map[string]*qdrant.Value)
	for k, v := range payload {
		switch val := v.(type) {
		case string:
			qdrantPayload[k] = &qdrant.Value{
				Kind: &qdrant.Value_StringValue{StringValue: val},
			}
		case int:
			qdrantPayload[k] = &qdrant.Value{
				Kind: &qdrant.Value_IntegerValue{IntegerValue: int64(val)},
			}
		case float64:
			qdrantPayload[k] = &qdrant.Value{
				Kind: &qdrant.Value_DoubleValue{DoubleValue: val},
			}
		}
	}

	_, err := q.client.SetPayload(ctx, &qdrant.SetPayloadPoints{
		CollectionName: q.collection,
		Payload:        qdrantPayload,
		PointsSelector: &qdrant.PointsSelector{
			PointsSelectorOneOf: &qdrant.PointsSelector_Filter{
				Filter: filter,
			},
		},
	})

	if err != nil {
		log.Warn().
			Err(err).
			Msg("failed to set payload by filter in Qdrant")
	}
	return err
}

// UpdateFilePath updates the filePath payload field for all points with the old path.
// This is the recommended way to handle file moves - preserves vectors and other payload.
func (q *QdrantClient) UpdateFilePath(oldPath, newPath string) error {
	if q == nil {
		return nil
	}

	filter := &qdrant.Filter{
		Must: []*qdrant.Condition{
			{
				ConditionOneOf: &qdrant.Condition_Field{
					Field: &qdrant.FieldCondition{
						Key: "filePath",
						Match: &qdrant.Match{
							MatchValue: &qdrant.Match_Keyword{
								Keyword: oldPath,
							},
						},
					},
				},
			},
		},
	}

	return q.SetPayloadByFilter(filter, map[string]interface{}{
		"filePath": newPath,
	})
}
