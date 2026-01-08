package vendors

import (
	"context"
	"sync"

	"github.com/qdrant/go-client/qdrant"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/config"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/log"
)

var (
	qdrantClient     *QdrantClient
	qdrantClientOnce sync.Once
	qdrantLogger     = log.GetLogger("Qdrant")
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
		cfg := config.Get()
		if cfg.QdrantHost == "" {
			qdrantLogger.Warn().Msg("QDRANT_HOST not configured, Qdrant disabled")
			return
		}

		client, err := qdrant.NewClient(&qdrant.Config{
			Host: cfg.QdrantHost,
			// APIKey: cfg.QdrantAPIKey, // Add if using cloud Qdrant
		})
		if err != nil {
			qdrantLogger.Error().Err(err).Msg("failed to create Qdrant client")
			return
		}

		// Ensure collection exists
		exists, err := client.CollectionExists(context.Background(), cfg.QdrantCollection)
		if err != nil {
			qdrantLogger.Error().Err(err).Msg("failed to check collection")
			return
		}

		if !exists {
			// Create collection with default config
			err = client.CreateCollection(context.Background(), &qdrant.CreateCollection{
				CollectionName: cfg.QdrantCollection,
				VectorsConfig: qdrant.NewVectorsConfig(&qdrant.VectorParams{
					Size:     1536, // OpenAI ada-002 dimension
					Distance: qdrant.Distance_Cosine,
				}),
			})
			if err != nil {
				qdrantLogger.Error().Err(err).Msg("failed to create collection")
				return
			}
			qdrantLogger.Info().Str("collection", cfg.QdrantCollection).Msg("created Qdrant collection")
		}

		qdrantClient = &QdrantClient{
			client:     client,
			collection: cfg.QdrantCollection,
		}

		qdrantLogger.Info().Str("host", cfg.QdrantHost).Str("collection", cfg.QdrantCollection).Msg("Qdrant initialized")
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
