package digest

import (
	"sync"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/internal/log"
)

var logger = log.GetLogger("DigestWorker")

// Worker manages digest processing
type Worker struct {
	stopChan   chan struct{}
	wg         sync.WaitGroup
	queue      chan string
	processing sync.Map // Currently processing files
}

// NewWorker creates a new digest worker
func NewWorker() *Worker {
	return &Worker{
		stopChan: make(chan struct{}),
		queue:    make(chan string, 1000),
	}
}

// Start begins processing digests
func (w *Worker) Start() {
	logger.Info().Msg("starting digest worker")

	// Start processing loop
	w.wg.Add(1)
	go w.processLoop()

	// Start supervisor loop
	w.wg.Add(1)
	go w.supervisorLoop()
}

// Stop stops the digest worker
func (w *Worker) Stop() {
	close(w.stopChan)
	w.wg.Wait()
	logger.Info().Msg("digest worker stopped")
}

// OnFileChange handles file change events from FS worker
func (w *Worker) OnFileChange(filePath string, isNew bool, contentChanged bool) {
	select {
	case w.queue <- filePath:
		logger.Debug().
			Str("path", filePath).
			Bool("isNew", isNew).
			Bool("contentChanged", contentChanged).
			Msg("queued file for digest")
	default:
		logger.Warn().Str("path", filePath).Msg("digest queue full, dropping file")
	}
}

// RequestDigest queues a file for digest processing
func (w *Worker) RequestDigest(filePath string) {
	select {
	case w.queue <- filePath:
	default:
		// Queue full, ignore
	}
}

// processLoop processes files from the queue
func (w *Worker) processLoop() {
	defer w.wg.Done()

	for {
		select {
		case filePath := <-w.queue:
			w.processFile(filePath)
		case <-w.stopChan:
			return
		}
	}
}

// processFile processes a single file through all digesters
func (w *Worker) processFile(filePath string) {
	// Check if already processing
	if _, loaded := w.processing.LoadOrStore(filePath, true); loaded {
		return
	}
	defer w.processing.Delete(filePath)

	logger.Debug().Str("path", filePath).Msg("processing file")

	// TODO: Implement full digest pipeline
	// 1. Get file record from database
	// 2. Determine applicable digesters
	// 3. Run digesters in dependency order
	// 4. Store results in database
	// 5. Update search indexes

	// For now, just log
	logger.Debug().Str("path", filePath).Msg("digest processing complete")
}

// supervisorLoop periodically checks for pending digests
func (w *Worker) supervisorLoop() {
	defer w.wg.Done()

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			w.checkPendingDigests()
		case <-w.stopChan:
			return
		}
	}
}

// checkPendingDigests finds and queues files with pending digests
func (w *Worker) checkPendingDigests() {
	// TODO: Query database for files with pending/failed digests
	// and queue them for reprocessing
}
