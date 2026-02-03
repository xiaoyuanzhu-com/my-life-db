package fs

import (
	"context"
	"os"
	"path/filepath"

	"github.com/fsnotify/fsnotify"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// watcher handles filesystem watching using fsnotify
type watcher struct {
	service      *Service
	watcher      *fsnotify.Watcher
	debouncer    *debouncer
	moveDetector *moveDetector
	stopChan     chan struct{}
	ctx          context.Context    // For cancellation during shutdown
	cancel       context.CancelFunc // To cancel in-flight operations
}

// newWatcher creates a new filesystem watcher
func newWatcher(service *Service) *watcher {
	ctx, cancel := context.WithCancel(context.Background())
	w := &watcher{
		service:  service,
		stopChan: make(chan struct{}),
		ctx:      ctx,
		cancel:   cancel,
	}
	// Initialize debouncer with default delay to coalesce rapid events
	w.debouncer = newDebouncer(DefaultDebounceDelay, w.processDebounced)
	// Initialize move detector with default TTL to correlate RENAME+CREATE events
	w.moveDetector = newMoveDetector(DefaultMoveDetectorTTL, service.cfg.DataRoot)
	return w
}

// Start begins watching the filesystem
func (w *watcher) Start() error {
	var err error
	w.watcher, err = fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	log.Info().Str("dataRoot", w.service.cfg.DataRoot).Msg("starting filesystem watcher")

	// Watch the data root directory recursively
	if err := w.watchRecursive(w.service.cfg.DataRoot); err != nil {
		log.Error().Err(err).Msg("failed to watch data directory")
		return err
	}

	// Start the event loop
	w.service.wg.Add(1)
	go w.eventLoop()

	log.Info().Msg("filesystem watcher started")
	return nil
}

// Stop stops the filesystem watcher gracefully.
// It cancels the context first to stop in-flight operations,
// then stops the debouncer to prevent new events from being processed.
func (w *watcher) Stop() {
	// Cancel context first to stop in-flight metadata computations
	if w.cancel != nil {
		w.cancel()
	}

	// Stop debouncer before closing stopChan to prevent race
	// where events try to queue after debouncer is stopped
	if w.debouncer != nil {
		w.debouncer.Stop()
	}

	// Clear move detector
	if w.moveDetector != nil {
		w.moveDetector.Clear()
	}

	// Signal event loop to exit
	close(w.stopChan)

	// Close fsnotify watcher
	if w.watcher != nil {
		w.watcher.Close()
	}
}

// processDebounced is called by the debouncer when an event is ready to be processed
func (w *watcher) processDebounced(path string, eventType EventType) {
	switch eventType {
	case EventCreate:
		w.handleCreate(path)
	case EventWrite:
		w.handleWrite(path)
	case EventDelete:
		w.handleDelete(path)
	}
}

// watchRecursive adds all directories under root to the watcher
func (w *watcher) watchRecursive(root string) error {
	return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // Skip errors
		}

		// Get relative path
		relPath, _ := filepath.Rel(w.service.cfg.DataRoot, path)

		// Skip excluded paths
		if w.service.validator.IsExcluded(relPath) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		// Add directory to watcher
		if info.IsDir() {
			if err := w.watcher.Add(path); err != nil {
				log.Warn().Err(err).Str("path", path).Msg("failed to watch directory")
			}
		}

		return nil
	})
}

// eventLoop processes filesystem events
func (w *watcher) eventLoop() {
	defer w.service.wg.Done()

	for {
		select {
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			w.handleEvent(event)

		case err, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
			log.Error().Err(err).Msg("watcher error")

		case <-w.stopChan:
			return
		}
	}
}

// handleEvent processes a single filesystem event
func (w *watcher) handleEvent(event fsnotify.Event) {
	relPath, err := filepath.Rel(w.service.cfg.DataRoot, event.Name)
	if err != nil {
		return
	}

	// Skip excluded paths
	if w.service.validator.IsExcluded(relPath) {
		return
	}

	// Get file info (single stat call)
	info, err := os.Stat(event.Name)
	if err != nil {
		// File was deleted or is inaccessible
		// Handle both Remove AND Rename - both mean "file gone from this path"
		if event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
			// Track RENAME for move detection (before processing as delete)
			// When a file is moved, fsnotify sends RENAME(old) then CREATE(new)
			if event.Op&fsnotify.Rename != 0 {
				// Try to get file size from DB for better move matching
				var size int64
				if record, _ := w.service.cfg.DB.GetFileByPath(relPath); record != nil && record.Size != nil {
					size = int64(*record.Size)
				}
				w.moveDetector.TrackRename(relPath, size)
			}
			// DELETE events are processed immediately (no debounce)
			w.debouncer.Queue(relPath, EventDelete)
		}
		return
	}

	// Determine event type
	isCreate := event.Op&fsnotify.Create != 0
	isWrite := event.Op&fsnotify.Write != 0

	// Handle directory creation
	if info.IsDir() {
		if isCreate {
			// Add new directory to watcher
			w.watcher.Add(event.Name)
		}
		return // Don't process directory events further
	}

	// Handle file events via debouncer to coalesce rapid changes
	if isCreate {
		w.debouncer.Queue(relPath, EventCreate)
	} else if isWrite {
		w.debouncer.Queue(relPath, EventWrite)
	}
}

// handleCreate handles file creation events
func (w *watcher) handleCreate(path string) {
	// Check if this CREATE is part of a move operation (recent RENAME + CREATE with same filename)
	if oldPath, isMove := w.moveDetector.CheckMove(path); isMove {
		log.Info().
			Str("oldPath", oldPath).
			Str("newPath", path).
			Msg("detected external file move")
		w.processMove(oldPath, path)
		return
	}

	// Try to acquire the file lock (same mechanism as scanner uses)
	// This ensures proper coordination between watcher, scanner, and API
	fileMu := w.service.fileLock.acquireFileLock(path)
	if !fileMu.TryLock() {
		// File is being processed by scanner or API - skip
		log.Debug().
			Str("path", path).
			Msg("file locked by another operation, skipping fsnotify create event")
		return
	}

	// Also check processing flag for duplicate watcher events
	if w.service.fileLock.isProcessing(path) {
		fileMu.Unlock()
		log.Debug().
			Str("path", path).
			Msg("file already being processed by watcher, skipping")
		return
	}

	// Mark as processing to prevent duplicate watcher processing
	w.service.fileLock.markProcessing(path)

	log.Info().
		Str("path", path).
		Msg("detected external file creation, processing")

	// Process file (compute metadata and update DB)
	w.service.wg.Add(1)
	go func() {
		defer w.service.wg.Done()
		defer fileMu.Unlock()
		defer w.service.fileLock.unmarkProcessing(path)
		w.processExternalFile(path, "fsnotify_create")
	}()
}

// handleWrite handles file write/modification events
func (w *watcher) handleWrite(path string) {
	// Try to acquire the file lock (same mechanism as scanner uses)
	// This ensures proper coordination between watcher, scanner, and API
	fileMu := w.service.fileLock.acquireFileLock(path)
	if !fileMu.TryLock() {
		// File is being processed by scanner or API - skip
		log.Debug().
			Str("path", path).
			Msg("file locked by another operation, skipping fsnotify write event")
		return
	}

	// Also check processing flag for duplicate watcher events
	if w.service.fileLock.isProcessing(path) {
		fileMu.Unlock()
		log.Debug().
			Str("path", path).
			Msg("file already being processed by watcher, skipping")
		return
	}

	// Mark as processing to prevent duplicate watcher processing
	w.service.fileLock.markProcessing(path)

	log.Debug().
		Str("path", path).
		Msg("detected external file modification, processing")

	// Process file modification
	w.service.wg.Add(1)
	go func() {
		defer w.service.wg.Done()
		defer fileMu.Unlock()
		defer w.service.fileLock.unmarkProcessing(path)
		w.processExternalFile(path, "fsnotify_write")
	}()
}

// handleDelete handles file deletion events
func (w *watcher) handleDelete(path string) {
	log.Info().
		Str("path", path).
		Msg("detected external file deletion, updating database")

	// Delete from database with cascade (deletes digests, pins, meili, qdrant)
	if err := w.service.cfg.DB.DeleteFileWithCascade(path); err != nil {
		log.Warn().
			Err(err).
			Str("path", path).
			Msg("failed to delete file from database")
	}

	// Release lock (garbage collection)
	w.service.fileLock.releaseFileLock(path)
}

// processExternalFile processes a file that was created/modified externally
// (e.g., via AirDrop, manual copy, etc.)
func (w *watcher) processExternalFile(path string, trigger string) {
	// Get file info
	fullPath := filepath.Join(w.service.cfg.DataRoot, path)
	info, err := os.Stat(fullPath)
	if err != nil {
		log.Warn().
			Err(err).
			Str("path", path).
			Msg("failed to stat file during external processing")
		return
	}

	// Get existing record (for change detection)
	existing, _ := w.service.cfg.DB.GetFileByPath(path)
	oldHash := ""
	if existing != nil && existing.Hash != nil {
		oldHash = *existing.Hash
	}

	// Compute metadata (use watcher context for cancellation)
	metadata, err := w.service.processor.ComputeMetadata(w.ctx, path)
	if err != nil {
		// Check if context was cancelled (shutdown in progress)
		if w.ctx.Err() != nil {
			log.Debug().
				Str("path", path).
				Msg("metadata computation cancelled during shutdown")
			return
		}

		log.Error().
			Err(err).
			Str("path", path).
			Msg("failed to compute metadata for external file")

		// Only create a basic record if no record exists yet.
		// If a record already exists (possibly with hash/preview from a previous scan),
		// don't overwrite it with empty metadata - let the scanner fix it later.
		if existing == nil {
			record := w.service.buildFileRecord(path, info, nil)
			if _, err := w.service.cfg.DB.UpsertFile(record); err != nil {
				log.Error().
					Err(err).
					Str("path", path).
					Msg("failed to upsert basic file record")
			}
		}
		return
	}

	// Create/update database record with metadata
	record := w.service.buildFileRecord(path, info, metadata)
	isNew, err := w.service.cfg.DB.UpsertFile(record)
	if err != nil {
		log.Error().
			Err(err).
			Str("path", path).
			Msg("failed to upsert file record")
		return
	}

	// Detect content change
	newHash := metadata.Hash
	contentChanged := (oldHash == "" && newHash != "") || (oldHash != "" && oldHash != newHash)

	// Notify digest service if content changed
	if contentChanged {
		log.Info().
			Str("path", path).
			Bool("isNew", isNew).
			Msg("external file content changed, notifying digest service")

		w.service.notifyFileChange(FileChangeEvent{
			FilePath:       path,
			IsNew:          isNew,
			ContentChanged: true,
			Trigger:        trigger,
		})
	}

	log.Info().
		Str("path", path).
		Bool("isNew", isNew).
		Bool("hashComputed", true).
		Str("trigger", trigger).
		Msg("external file processed successfully")
}

// processMove handles an external file move/rename operation.
// It atomically updates the database to reflect the new path while preserving
// related records (digests, pins).
func (w *watcher) processMove(oldPath, newPath string) {
	// Get file info at new location
	fullPath := filepath.Join(w.service.cfg.DataRoot, newPath)
	info, err := os.Stat(fullPath)
	if err != nil {
		log.Warn().
			Err(err).
			Str("newPath", newPath).
			Msg("failed to stat moved file")
		return
	}

	// Get old record if exists (for hash preservation)
	oldRecord, _ := w.service.cfg.DB.GetFileByPath(oldPath)
	var oldHash string
	if oldRecord != nil && oldRecord.Hash != nil {
		oldHash = *oldRecord.Hash
	}

	// Compute metadata for new location (use watcher context for cancellation)
	metadata, err := w.service.processor.ComputeMetadata(w.ctx, newPath)
	if err != nil {
		// Check if context was cancelled (shutdown in progress)
		if w.ctx.Err() != nil {
			log.Debug().
				Str("path", newPath).
				Msg("move processing cancelled during shutdown")
			return
		}

		log.Warn().
			Err(err).
			Str("path", newPath).
			Msg("failed to compute metadata for moved file, proceeding with old hash")
		// Use old hash if metadata computation fails
		if oldHash != "" {
			metadata = &MetadataResult{Hash: oldHash}
		}
	}

	// Build record for new path
	record := w.service.buildFileRecord(newPath, info, metadata)

	// Atomic move in database
	if err := w.service.cfg.DB.MoveFileAtomic(oldPath, newPath, record); err != nil {
		log.Error().
			Err(err).
			Str("oldPath", oldPath).
			Str("newPath", newPath).
			Msg("failed to move file record atomically")
		return
	}

	// Sync external search services (Meili, Qdrant) - best effort, async
	go db.SyncSearchIndexOnMove(oldPath, newPath)

	// Notify of file change (location changed, not content)
	w.service.notifyFileChange(FileChangeEvent{
		FilePath:       newPath,
		IsNew:          false,
		ContentChanged: false, // Content didn't change, just location
		Trigger:        "fsnotify_move",
	})

	log.Info().
		Str("oldPath", oldPath).
		Str("newPath", newPath).
		Msg("external file move processed successfully")
}
