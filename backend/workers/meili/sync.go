package meili

import (
	"sync"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/vendors"
)

const (
	// syncBatchSize is the max number of documents to sync per tick
	syncBatchSize = 50

	// syncInterval is how often we poll for pending documents
	syncInterval = 10 * time.Second

	// initialDelay before the first poll (let digest worker warm up)
	initialDelay = 5 * time.Second
)

// SyncWorker pushes pending meili_documents to Meilisearch.
type SyncWorker struct {
	stopChan chan struct{}
	wg       sync.WaitGroup

	// nudgeChan allows immediate sync after a digest completes
	nudgeChan chan struct{}
}

// NewSyncWorker creates a new Meilisearch sync worker.
func NewSyncWorker() *SyncWorker {
	return &SyncWorker{
		stopChan:  make(chan struct{}),
		nudgeChan: make(chan struct{}, 1), // buffered so nudge never blocks
	}
}

// Start begins the sync loop.
func (w *SyncWorker) Start() {
	w.wg.Add(1)
	go w.loop()
	log.Info().Msg("meili sync worker started")
}

// Stop signals the worker to exit and waits for it to finish.
func (w *SyncWorker) Stop() {
	close(w.stopChan)
	w.wg.Wait()
	log.Info().Msg("meili sync worker stopped")
}

// Nudge asks the worker to run a sync cycle as soon as possible.
// Non-blocking — if a nudge is already pending it is a no-op.
func (w *SyncWorker) Nudge() {
	select {
	case w.nudgeChan <- struct{}{}:
	default:
		// already nudged
	}
}

// loop is the main goroutine.
func (w *SyncWorker) loop() {
	defer w.wg.Done()

	// Wait a bit before first sync to let other services initialize
	select {
	case <-time.After(initialDelay):
	case <-w.stopChan:
		return
	}

	// Run an initial full sync on startup
	w.syncPending()

	ticker := time.NewTicker(syncInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			w.syncPending()
		case <-w.nudgeChan:
			w.syncPending()
		case <-w.stopChan:
			return
		}
	}
}

// syncPending fetches pending documents from SQLite and pushes them to Meilisearch.
// Processes in batches until all pending documents are synced.
func (w *SyncWorker) syncPending() {
	meili := vendors.GetMeiliClient()
	if meili == nil {
		// Meilisearch not configured — nothing to do
		return
	}

	totalIndexed := 0
	totalFailed := 0

	for {
		docs, err := db.ListMeiliDocumentsByStatus("pending", syncBatchSize)
		if err != nil {
			log.Error().Err(err).Msg("meili sync: failed to list pending documents")
			return
		}

		if len(docs) == 0 {
			break
		}

		log.Info().Int("count", len(docs)).Msg("meili sync: pushing pending documents")

		for _, doc := range docs {
			// Check for shutdown between documents
			select {
			case <-w.stopChan:
				log.Info().Int("indexed", totalIndexed).Msg("meili sync: interrupted by shutdown")
				return
			default:
			}

			// Mark as indexing
			db.UpdateMeiliStatus(doc.DocumentID, "indexing", nil, nil)

			// Build the document payload for Meilisearch
			meiliDoc := map[string]interface{}{
				"documentId": doc.DocumentID,
				"filePath":   doc.FilePath,
				"content":    doc.Content,
			}
			if doc.Summary != nil {
				meiliDoc["summary"] = *doc.Summary
			}
			if doc.Tags != nil {
				meiliDoc["tags"] = *doc.Tags
			}
			if doc.MimeType != nil {
				meiliDoc["mimeType"] = *doc.MimeType
			}

			if err := meili.IndexDocument(meiliDoc); err != nil {
				errMsg := err.Error()
				db.UpdateMeiliStatus(doc.DocumentID, "error", nil, &errMsg)
				log.Warn().Err(err).Str("path", doc.FilePath).Msg("meili sync: failed to index document")
				totalFailed++
				continue
			}

			// Mark as indexed
			db.UpdateMeiliStatus(doc.DocumentID, "indexed", nil, nil)
			totalIndexed++
		}

		// If this batch was smaller than the limit, we've drained all pending docs
		if len(docs) < syncBatchSize {
			break
		}
	}

	if totalIndexed > 0 || totalFailed > 0 {
		log.Info().Int("indexed", totalIndexed).Int("failed", totalFailed).Msg("meili sync: cycle complete")
	}
}
