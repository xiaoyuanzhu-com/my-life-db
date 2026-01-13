package fs

import (
	"context"
	"os"
	"path/filepath"

	"github.com/fsnotify/fsnotify"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// watcher handles filesystem watching using fsnotify
type watcher struct {
	service  *Service
	watcher  *fsnotify.Watcher
	stopChan chan struct{}
}

// newWatcher creates a new filesystem watcher
func newWatcher(service *Service) *watcher {
	return &watcher{
		service:  service,
		stopChan: make(chan struct{}),
	}
}

// Start begins watching the filesystem
func (w *watcher) Start() error {
	var err error
	w.watcher, err = fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	log.Info().Str("dataRoot", w.service.dataRoot).Msg("starting filesystem watcher")

	// Watch the data root directory recursively
	if err := w.watchRecursive(w.service.dataRoot); err != nil {
		log.Error().Err(err).Msg("failed to watch data directory")
		return err
	}

	// Start the event loop
	w.service.wg.Add(1)
	go w.eventLoop()

	log.Info().Msg("filesystem watcher started")
	return nil
}

// Stop stops the filesystem watcher
func (w *watcher) Stop() {
	close(w.stopChan)
	if w.watcher != nil {
		w.watcher.Close()
	}
}

// watchRecursive adds all directories under root to the watcher
func (w *watcher) watchRecursive(root string) error {
	return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // Skip errors
		}

		// Get relative path
		relPath, _ := filepath.Rel(w.service.dataRoot, path)

		// Skip excluded paths
		if w.service.validator.isExcluded(relPath) {
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
	relPath, err := filepath.Rel(w.service.dataRoot, event.Name)
	if err != nil {
		return
	}

	// Skip excluded paths
	if w.service.validator.isExcluded(relPath) {
		return
	}

	// Get file info (single stat call)
	info, err := os.Stat(event.Name)
	if err != nil {
		// File was deleted or is inaccessible
		if event.Op&fsnotify.Remove != 0 {
			w.handleDelete(relPath)
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

	// Handle file events
	if isCreate {
		w.handleCreate(relPath)
	} else if isWrite {
		w.handleWrite(relPath)
	}
}

// handleCreate handles file creation events
func (w *watcher) handleCreate(path string) {
	// Check if already processing (API might have just created it)
	if w.service.fileLock.isProcessing(path) {
		log.Debug().
			Str("path", path).
			Msg("file already being processed, skipping fsnotify create event")
		return
	}

	// Mark as processing
	if !w.service.fileLock.markProcessing(path) {
		log.Debug().
			Str("path", path).
			Msg("file already marked for processing, skipping")
		return
	}
	defer w.service.fileLock.unmarkProcessing(path)

	log.Info().
		Str("path", path).
		Msg("detected external file creation, processing")

	// Process file (compute metadata and update DB)
	w.service.wg.Add(1)
	go func() {
		defer w.service.wg.Done()
		w.processExternalFile(path, "fsnotify_create")
	}()
}

// handleWrite handles file write/modification events
func (w *watcher) handleWrite(path string) {
	// Check if already processing
	if w.service.fileLock.isProcessing(path) {
		log.Debug().
			Str("path", path).
			Msg("file already being processed, skipping fsnotify write event")
		return
	}

	// Mark as processing
	if !w.service.fileLock.markProcessing(path) {
		log.Debug().
			Str("path", path).
			Msg("file already marked for processing, skipping")
		return
	}
	defer w.service.fileLock.unmarkProcessing(path)

	log.Debug().
		Str("path", path).
		Msg("detected external file modification, processing")

	// Process file modification
	w.service.wg.Add(1)
	go func() {
		defer w.service.wg.Done()
		w.processExternalFile(path, "fsnotify_write")
	}()
}

// handleDelete handles file deletion events
func (w *watcher) handleDelete(path string) {
	log.Info().
		Str("path", path).
		Msg("detected external file deletion, updating database")

	// Delete from database
	if err := w.service.db.DeleteFile(path); err != nil {
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
	fullPath := filepath.Join(w.service.dataRoot, path)
	info, err := os.Stat(fullPath)
	if err != nil {
		log.Warn().
			Err(err).
			Str("path", path).
			Msg("failed to stat file during external processing")
		return
	}

	// Get existing record (for change detection)
	existing, _ := w.service.db.GetFileByPath(path)
	oldHash := ""
	if existing != nil && existing.Hash != nil {
		oldHash = *existing.Hash
	}

	// Compute metadata
	metadata, err := w.service.processor.ComputeMetadata(context.Background(), path)
	if err != nil {
		log.Error().
			Err(err).
			Str("path", path).
			Msg("failed to compute metadata for external file")

		// Fallback: create basic record without metadata
		record := w.service.buildFileRecord(path, info, nil)
		if _, err := w.service.db.UpsertFile(record); err != nil {
			log.Error().
				Err(err).
				Str("path", path).
				Msg("failed to upsert basic file record")
		}
		return
	}

	// Create/update database record with metadata
	record := w.service.buildFileRecord(path, info, metadata)
	isNew, err := w.service.db.UpsertFile(record)
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
