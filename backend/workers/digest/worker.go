package digest

import (
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
)

// Worker manages digest processing
type Worker struct {
	cfg   Config
	db    *db.DB
	notif *notifications.Service

	stopChan   chan struct{}
	wg         sync.WaitGroup
	queue      chan string
	processing sync.Map // Currently processing files
}

// NewWorker creates a new digest worker with dependencies
func NewWorker(cfg Config, database *db.DB, notifService *notifications.Service) *Worker {
	if cfg.QueueSize == 0 {
		cfg.QueueSize = 1000
	}
	if cfg.Workers == 0 {
		cfg.Workers = 3
	}

	return &Worker{
		cfg:      cfg,
		db:       database,
		notif:    notifService,
		stopChan: make(chan struct{}),
		queue:    make(chan string, cfg.QueueSize),
	}
}

// Start begins processing digests
func (w *Worker) Start() {
	log.Info().Int("workers", w.cfg.Workers).Msg("starting digest worker")

	// Initialize the digester registry
	InitializeRegistry()

	// Ensure all files have digest placeholders on startup
	w.wg.Add(1)
	go w.ensureAllFilesHaveDigests()

	// Start multiple processing goroutines for parallelism
	for i := 0; i < w.cfg.Workers; i++ {
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
	// Only auto-digest files in inbox directory
	// Library files get basic file records and metadata, but no digests
	if !isInboxFile(filePath) {
		log.Debug().
			Str("path", filePath).
			Msg("skipping auto-digest for non-inbox file")
		return
	}

	// For new files, ensure digest placeholders exist (matches Node.js behavior)
	if isNew {
		added, _ := w.EnsureDigestersForFile(filePath)
		log.Info().Str("path", filePath).Int("added", added).Msg("new file detected, ensured all digesters")
	}

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

// EnsureDigestersForFile creates placeholder digest records for all registered digesters
// if they don't already exist for the given file. Also marks orphaned digesters as skipped.
// This matches the Node.js ensureAllDigesters behavior.
func (w *Worker) EnsureDigestersForFile(filePath string) (added int, orphanedSkipped int) {
	digesters := GlobalRegistry.GetAll()

	// Build set of all valid digest types
	validTypes := make(map[string]bool)
	for _, digester := range digesters {
		outputNames := getOutputNames(digester)
		for _, name := range outputNames {
			validTypes[name] = true
		}
	}

	// Get existing digests
	existing := db.ListDigestsForPath(filePath)
	existingTypes := make(map[string]bool)
	for _, d := range existing {
		existingTypes[d.Digester] = true
	}

	// Add missing digesters
	for digestType := range validTypes {
		if existingTypes[digestType] {
			continue
		}
		getOrCreateDigestID(filePath, digestType)
		added++
	}

	// Mark orphaned digesters as skipped
	now := db.NowUTC()
	for _, digest := range existing {
		if !validTypes[digest.Digester] && (digest.Status == "todo" || digest.Status == "failed") {
			db.UpdateDigestMap(digest.ID, map[string]interface{}{
				"status":     "skipped",
				"error":      "Digester no longer registered",
				"updated_at": now,
			})
			orphanedSkipped++
		}
	}

	if added > 0 || orphanedSkipped > 0 {
		log.Info().
			Str("path", filePath).
			Int("added", added).
			Int("orphaned", orphanedSkipped).
			Msg("ensured digest placeholders")
	} else {
		log.Debug().Str("path", filePath).Msg("digests already ensured")
	}

	return added, orphanedSkipped
}

// ensureAllFilesHaveDigests runs once on startup to ensure all files have digest placeholders
// This handles files that were added before the EnsureDigestersForFile logic was implemented,
// and also backfills when new digesters are added to the registry.
// Only processes inbox files - library files don't get auto-digested.
func (w *Worker) ensureAllFilesHaveDigests() {
	defer w.wg.Done()

	log.Info().Msg("backfilling digest placeholders for inbox files")

	// Query all non-folder files in inbox directory
	query := `SELECT path FROM files WHERE is_folder = 0 AND (path = 'inbox' OR path LIKE 'inbox/%')`
	rows, err := db.GetDB().Query(query)
	if err != nil {
		log.Error().Err(err).Msg("failed to query files for digest placeholder creation")
		return
	}
	defer rows.Close()

	fileCount := 0
	totalAdded := 0
	totalOrphaned := 0

	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			continue
		}
		added, orphaned := w.EnsureDigestersForFile(path)
		totalAdded += added
		totalOrphaned += orphaned
		fileCount++
	}

	log.Info().
		Int("files", fileCount).
		Int("added", totalAdded).
		Int("orphaned", totalOrphaned).
		Msg("backfill complete")
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
		log.Debug().Str("path", filePath).Msg("already processing, skipping")
		return
	}
	defer w.processing.Delete(filePath)

	log.Info().Str("path", filePath).Msg("processing file")

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
			w.saveDigestOutput(filePath, output)
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

func isScreenshotDigester(digester string) bool {
	// Digesters that produce screenshots/previews for display
	return digester == "url-crawl-screenshot" ||
		digester == "doc-to-screenshot" ||
		digester == "image-preview"
}

// notifyPreviewReady sends a notification when a preview/screenshot is ready
func (w *Worker) notifyPreviewReady(filePath string, digester string) {
	// Determine preview type based on digester
	previewType := "screenshot"
	if digester == "image-preview" {
		previewType = "image"
	}

	w.notif.NotifyPreviewUpdated(filePath, previewType)

	log.Debug().
		Str("filePath", filePath).
		Str("digester", digester).
		Str("previewType", previewType).
		Msg("preview updated notification sent")
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

func (w *Worker) saveDigestOutput(filePath string, output DigestInput) {
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

		// Store binary data in SQLAR if provided
		if len(output.SqlarData) > 0 {
			// Construct full SQLAR path: {file_hash}/{digester}/{filename}
			fileHash := db.GeneratePathHash(filePath)
			sqlarPath := fileHash + "/" + output.Digester + "/" + *output.SqlarName
			db.SqlarStore(sqlarPath, output.SqlarData, 0644)

			// Update files.screenshot_sqlar for screenshot digesters
			if output.Status == DigestStatusCompleted && isScreenshotDigester(output.Digester) {
				db.UpdateFileField(filePath, "screenshot_sqlar", sqlarPath)

				// Notify clients that preview is ready
				w.notifyPreviewReady(filePath, output.Digester)
			}
		}
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

// isInboxFile checks if a file path is in the inbox directory
func isInboxFile(filePath string) bool {
	// Check if path starts with "inbox/" or is exactly "inbox"
	return filePath == "inbox" || len(filePath) > 6 && filePath[:6] == "inbox/"
}
