package digest

import (
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

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
	log.Info().Msg("starting digest worker")

	// Initialize the digester registry
	InitializeRegistry()

	// Start multiple processing goroutines for parallelism
	numWorkers := 3
	for i := 0; i < numWorkers; i++ {
		w.wg.Add(1)
		go w.processLoop(i)
	}

	// Start supervisor loop
	w.wg.Add(1)
	go w.supervisorLoop()
}

// Stop stops the digest worker
func (w *Worker) Stop() {
	close(w.stopChan)
	w.wg.Wait()
	log.Info().Msg("digest worker stopped")
}

// OnFileChange handles file change events from FS worker
func (w *Worker) OnFileChange(filePath string, isNew bool, contentChanged bool) {
	select {
	case w.queue <- filePath:
		log.Debug().
			Str("path", filePath).
			Bool("isNew", isNew).
			Bool("contentChanged", contentChanged).
			Msg("queued file for digest")
	default:
		log.Warn().Str("path", filePath).Msg("digest queue full, dropping file")
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
func (w *Worker) processLoop(id int) {
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

	log.Debug().Str("path", filePath).Msg("processing file")

	// Get file record
	file, err := db.GetFileByPath(filePath)
	if err != nil || file == nil {
		log.Error().Str("path", filePath).Msg("file not found")
		return
	}

	// Get all digesters
	digesters := GlobalRegistry.GetAll()

	processed := 0
	skipped := 0
	failed := 0

	for _, digester := range digesters {
		digesterName := digester.Name()
		outputNames := getOutputNames(digester)

		// Load existing digests
		existingDigests := db.ListDigestsForPath(filePath)
		digestsByName := make(map[string]db.Digest)
		for _, d := range existingDigests {
			digestsByName[d.Digester] = d
		}

		// Check if outputs are in progress
		inProgress := false
		for _, name := range outputNames {
			if d, ok := digestsByName[name]; ok && d.Status == "in-progress" {
				inProgress = true
				break
			}
		}
		if inProgress {
			log.Debug().Str("path", filePath).Str("digester", digesterName).Msg("in progress, skipping")
			skipped++
			continue
		}

		// Check for pending outputs
		pendingOutputs := make([]string, 0)
		for _, name := range outputNames {
			if d, ok := digestsByName[name]; !ok {
				pendingOutputs = append(pendingOutputs, name)
			} else if d.Status == "todo" {
				pendingOutputs = append(pendingOutputs, name)
			} else if d.Status == "failed" && d.Attempts < MaxDigestAttempts {
				pendingOutputs = append(pendingOutputs, name)
			}
		}

		if len(pendingOutputs) == 0 {
			log.Debug().Str("path", filePath).Str("digester", digesterName).Msg("already completed")
			skipped++
			continue
		}

		// Check if can digest
		can, err := digester.CanDigest(filePath, file, nil)
		if err != nil {
			log.Error().Err(err).Str("path", filePath).Str("digester", digesterName).Msg("canDigest error")
			failed++
			continue
		}

		if !can {
			// Mark as skipped
			for _, name := range pendingOutputs {
				markDigest(filePath, name, DigestStatusSkipped, "Not applicable")
			}
			log.Debug().Str("path", filePath).Str("digester", digesterName).Msg("skipped")
			skipped++
			continue
		}

		// Mark as in-progress
		for _, name := range pendingOutputs {
			markDigestInProgress(filePath, name)
		}

		// Execute digester
		outputs, err := digester.Digest(filePath, file, existingDigests, nil)
		if err != nil {
			for _, name := range pendingOutputs {
				markDigest(filePath, name, DigestStatusFailed, err.Error())
			}
			log.Error().Err(err).Str("path", filePath).Str("digester", digesterName).Msg("digest failed")
			failed++
			continue
		}

		if len(outputs) == 0 {
			for _, name := range pendingOutputs {
				markDigest(filePath, name, DigestStatusFailed, "No output")
			}
			failed++
			continue
		}

		// Save outputs
		producedNames := make(map[string]bool)
		finalStatus := "completed"
		for _, output := range outputs {
			producedNames[output.Digester] = true
			saveDigestOutput(filePath, output)
			if output.Status == DigestStatusFailed {
				finalStatus = "failed"
			}
		}

		// Mark missing outputs as failed
		for _, name := range pendingOutputs {
			if !producedNames[name] {
				markDigest(filePath, name, DigestStatusFailed, "Output not produced")
			}
		}

		processed++
		log.Info().Str("path", filePath).Str("digester", digesterName).Str("status", finalStatus).Msg("processed")
	}

	log.Info().
		Str("path", filePath).
		Int("processed", processed).
		Int("skipped", skipped).
		Int("failed", failed).
		Msg("file processing complete")
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
	// Get files with pending or failed (retriable) digests
	files := db.GetFilesWithPendingDigests()
	for _, path := range files {
		select {
		case w.queue <- path:
		default:
			// Queue full
		}
	}
}

// Helper functions

func getOutputNames(d Digester) []string {
	outputs := d.GetOutputDigesters()
	if len(outputs) > 0 {
		return outputs
	}
	return []string{d.Name()}
}

func markDigest(filePath, digester string, status DigestStatus, errorMsg string) {
	id := getOrCreateDigestID(filePath, digester)
	now := db.NowUTC()

	var errPtr *string
	if errorMsg != "" {
		errPtr = &errorMsg
	}

	db.UpdateDigestMap(id, map[string]interface{}{
		"status":     string(status),
		"error":      errPtr,
		"updated_at": now,
	})
}

func markDigestInProgress(filePath, digester string) {
	id := getOrCreateDigestID(filePath, digester)
	now := db.NowUTC()

	existing, _ := db.GetDigestByID(id)
	attempts := 0
	if existing != nil {
		attempts = existing.Attempts + 1
	}

	db.UpdateDigestMap(id, map[string]interface{}{
		"status":     "in-progress",
		"attempts":   attempts,
		"updated_at": now,
	})
}

func saveDigestOutput(filePath string, output DigestInput) {
	id := getOrCreateDigestID(filePath, output.Digester)

	existing, _ := db.GetDigestByID(id)

	update := map[string]interface{}{
		"status":     string(output.Status),
		"updated_at": output.UpdatedAt,
	}

	if output.Content != nil {
		update["content"] = *output.Content
	}
	if output.SqlarName != nil {
		update["sqlar_name"] = *output.SqlarName
	}
	if output.Error != nil {
		update["error"] = *output.Error
	}

	if output.Status == DigestStatusCompleted || output.Status == DigestStatusSkipped {
		update["attempts"] = 0
	} else if output.Status == DigestStatusFailed {
		attempts := 1
		if existing != nil {
			attempts = existing.Attempts + 1
			if attempts > MaxDigestAttempts {
				attempts = MaxDigestAttempts
			}
		}
		update["attempts"] = attempts
	}

	db.UpdateDigestMap(id, update)

	// Trigger cascading resets if completed with content
	if output.Status == DigestStatusCompleted && output.Content != nil && *output.Content != "" {
		triggerCascadingResets(filePath, output.Digester)
	}
}

// triggerCascadingResets resets downstream digesters when an upstream digester completes with content
func triggerCascadingResets(filePath, digesterName string) {
	downstreamDigesters, ok := CascadingResets[digesterName]
	if !ok || len(downstreamDigesters) == 0 {
		return
	}

	existingDigests := db.ListDigestsForPath(filePath)
	digestsByName := make(map[string]db.Digest)
	for _, d := range existingDigests {
		digestsByName[d.Digester] = d
	}

	var resetTargets []string
	for _, downstream := range downstreamDigesters {
		if digest, ok := digestsByName[downstream]; ok {
			// Only reset terminal states (completed, skipped, failed)
			// Leave todo and in-progress alone
			if digest.Status == "completed" || digest.Status == "skipped" || digest.Status == "failed" {
				resetTargets = append(resetTargets, downstream)
			}
		}
	}

	if len(resetTargets) > 0 {
		log.Info().
			Str("path", filePath).
			Str("trigger", digesterName).
			Strs("targets", resetTargets).
			Msg("triggering cascading resets")

		now := db.NowUTC()
		for _, target := range resetTargets {
			digest := digestsByName[target]
			db.UpdateDigestMap(digest.ID, map[string]interface{}{
				"status":     "todo",
				"content":    nil,
				"error":      nil,
				"attempts":   0,
				"updated_at": now,
			})
		}
	}
}

func getOrCreateDigestID(filePath, digester string) string {
	existing := db.GetDigestByPathAndDigester(filePath, digester)
	if existing != nil {
		return existing.ID
	}

	id := uuid.New().String()
	now := db.NowUTC()

	db.CreateDigest(&db.Digest{
		ID:        id,
		FilePath:  filePath,
		Digester:  digester,
		Status:    "todo",
		CreatedAt: now,
		UpdatedAt: now,
	})

	return id
}
