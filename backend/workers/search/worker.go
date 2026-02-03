package search

import (
	"sync"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/vendors"
)

// Config holds worker configuration
type Config struct {
	// SyncInterval is how often to check for pending documents
	SyncInterval time.Duration
	// MeiliBatchSize is max documents to sync to Meilisearch per cycle
	MeiliBatchSize int
	// QdrantBatchSize is max documents to sync to Qdrant per cycle
	QdrantBatchSize int
}

// Worker syncs pending documents from SQLite to external search services
type Worker struct {
	cfg Config

	stopChan chan struct{}
	wg       sync.WaitGroup
}

// NewWorker creates a new search sync worker
func NewWorker(cfg Config) *Worker {
	// Apply defaults
	if cfg.SyncInterval == 0 {
		cfg.SyncInterval = 10 * time.Second
	}
	if cfg.MeiliBatchSize == 0 {
		cfg.MeiliBatchSize = 50
	}
	if cfg.QdrantBatchSize == 0 {
		cfg.QdrantBatchSize = 20 // Smaller batch for Qdrant since we need embeddings
	}

	return &Worker{
		cfg:      cfg,
		stopChan: make(chan struct{}),
	}
}

// Start begins the sync worker
func (w *Worker) Start() {
	log.Info().
		Dur("interval", w.cfg.SyncInterval).
		Int("meiliBatch", w.cfg.MeiliBatchSize).
		Int("qdrantBatch", w.cfg.QdrantBatchSize).
		Msg("starting search sync worker")

	// Meilisearch sync loop
	w.wg.Add(1)
	go w.meiliSyncLoop()

	// Qdrant sync loop
	w.wg.Add(1)
	go w.qdrantSyncLoop()
}

// Stop stops the sync worker
func (w *Worker) Stop() {
	close(w.stopChan)
	w.wg.Wait()
	log.Info().Msg("search sync worker stopped")
}

// meiliSyncLoop periodically syncs pending documents to Meilisearch
func (w *Worker) meiliSyncLoop() {
	defer w.wg.Done()

	// Initial sync
	w.syncMeiliPending()

	ticker := time.NewTicker(w.cfg.SyncInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			w.syncMeiliPending()
		case <-w.stopChan:
			return
		}
	}
}

// qdrantSyncLoop periodically syncs pending documents to Qdrant
func (w *Worker) qdrantSyncLoop() {
	defer w.wg.Done()

	// Initial sync
	w.syncQdrantPending()

	ticker := time.NewTicker(w.cfg.SyncInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			w.syncQdrantPending()
		case <-w.stopChan:
			return
		}
	}
}

// syncMeiliPending fetches pending documents and indexes them to Meilisearch
func (w *Worker) syncMeiliPending() {
	meili := vendors.GetMeiliClient()
	if meili == nil {
		return // Meilisearch not configured
	}

	docs, err := db.ListMeiliDocumentsByStatus("pending", w.cfg.MeiliBatchSize)
	if err != nil {
		log.Error().Err(err).Msg("failed to list pending meili documents")
		return
	}

	if len(docs) == 0 {
		return
	}

	log.Info().Int("count", len(docs)).Msg("syncing pending documents to Meilisearch")

	synced := 0
	failed := 0

	for _, doc := range docs {
		// Build document for Meilisearch
		meiliDoc := map[string]interface{}{
			"documentId": doc.DocumentID,
			"filePath":   doc.FilePath,
			"content":    doc.Content,
			"wordCount":  doc.WordCount,
		}

		if doc.Summary != nil && *doc.Summary != "" {
			meiliDoc["summary"] = *doc.Summary
		}
		if doc.Tags != nil && *doc.Tags != "" {
			meiliDoc["tags"] = *doc.Tags
		}
		if doc.MimeType != nil && *doc.MimeType != "" {
			meiliDoc["mimeType"] = *doc.MimeType
		}

		// Index to Meilisearch
		err := meili.IndexDocument(meiliDoc)
		if err != nil {
			errMsg := err.Error()
			db.UpdateMeiliStatus(doc.DocumentID, "error", nil, &errMsg)
			log.Warn().Err(err).Str("path", doc.FilePath).Msg("failed to index to Meilisearch")
			failed++
			continue
		}

		// Mark as indexed
		db.UpdateMeiliStatus(doc.DocumentID, "indexed", nil, nil)
		synced++
	}

	if synced > 0 || failed > 0 {
		log.Info().
			Int("synced", synced).
			Int("failed", failed).
			Msg("Meilisearch sync complete")
	}
}

// syncQdrantPending fetches pending documents, generates embeddings, and indexes to Qdrant
func (w *Worker) syncQdrantPending() {
	qdrant := vendors.GetQdrantClient()
	if qdrant == nil {
		return // Qdrant not configured
	}

	haid := vendors.GetHAIDClient()
	if haid == nil {
		return // HAID not configured (needed for embeddings)
	}

	docs, err := db.ListQdrantDocumentsByStatus("pending", w.cfg.QdrantBatchSize)
	if err != nil {
		log.Error().Err(err).Msg("failed to list pending qdrant documents")
		return
	}

	if len(docs) == 0 {
		return
	}

	log.Info().Int("count", len(docs)).Msg("syncing pending documents to Qdrant")

	// Collect texts for batch embedding
	texts := make([]string, len(docs))
	for i, doc := range docs {
		texts[i] = doc.ChunkText
	}

	// Generate embeddings
	embeddings, err := haid.Embed(texts)
	if err != nil {
		log.Error().Err(err).Msg("failed to generate embeddings")
		// Mark all as error
		errMsg := err.Error()
		for _, doc := range docs {
			db.UpdateQdrantEmbeddingStatus(doc.DocumentID, "error", nil, nil, &errMsg)
		}
		return
	}

	if len(embeddings) != len(docs) {
		log.Error().
			Int("expected", len(docs)).
			Int("got", len(embeddings)).
			Msg("embedding count mismatch")
		return
	}

	synced := 0
	failed := 0
	now := time.Now().UTC().Format(time.RFC3339)

	for i, doc := range docs {
		embedding := embeddings[i]

		// Build payload for Qdrant
		payload := map[string]interface{}{
			"filePath":   doc.FilePath,
			"sourceType": doc.SourceType,
			"text":       doc.ChunkText,
			"chunkIndex": doc.ChunkIndex,
			"chunkCount": doc.ChunkCount,
		}

		// Upsert to Qdrant
		err := qdrant.Upsert(doc.DocumentID, embedding, payload)
		if err != nil {
			errMsg := err.Error()
			db.UpdateQdrantEmbeddingStatus(doc.DocumentID, "error", nil, nil, &errMsg)
			log.Warn().Err(err).Str("path", doc.FilePath).Msg("failed to index to Qdrant")
			failed++
			continue
		}

		// Mark as indexed
		pointID := doc.DocumentID
		db.UpdateQdrantEmbeddingStatus(doc.DocumentID, "indexed", &pointID, &now, nil)
		synced++
	}

	if synced > 0 || failed > 0 {
		log.Info().
			Int("synced", synced).
			Int("failed", failed).
			Msg("Qdrant sync complete")
	}
}
