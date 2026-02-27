package fs

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

const (
	// Default scan interval (1 hour)
	defaultScanInterval = 1 * time.Hour

	// Initial scan delay after startup
	initialScanDelay = 10 * time.Second

	// Max concurrent metadata processing during scan
	maxScanConcurrency = 10
)

// scanner handles periodic filesystem scanning
type scanner struct {
	service  *Service
	interval time.Duration
	stopChan chan struct{}
}

// newScanner creates a new filesystem scanner
func newScanner(service *Service, interval time.Duration) *scanner {
	if interval == 0 {
		interval = defaultScanInterval
	}
	return &scanner{
		service:  service,
		interval: interval,
		stopChan: make(chan struct{}),
	}
}

// Start begins periodic scanning
func (s *scanner) Start() error {
	log.Info().
		Dur("interval", s.interval).
		Msg("starting filesystem scanner")

	// Initial scan after delay
	time.AfterFunc(initialScanDelay, func() {
		s.scan()
	})

	// Periodic scans
	ticker := time.NewTicker(s.interval)
	s.service.wg.Add(1)
	go func() {
		defer s.service.wg.Done()
		for {
			select {
			case <-ticker.C:
				s.scan()
			case <-s.stopChan:
				ticker.Stop()
				return
			}
		}
	}()

	log.Info().Msg("filesystem scanner started")
	return nil
}

// Stop stops the scanner
func (s *scanner) Stop() {
	close(s.stopChan)
}

// scan performs a full filesystem scan with two phases:
// Phase 1: Walk filesystem, identify files needing processing, track all seen paths
// Phase 2: Reconcile - remove DB records for files that no longer exist on disk
func (s *scanner) scan() {
	log.Info().Str("root", s.service.cfg.DataRoot).Msg("starting filesystem scan")
	startTime := time.Now()

	var filesToProcess []fileToProcess
	seenPaths := make(map[string]bool) // Track all files seen on disk

	// Phase 1: Walk filesystem and identify files needing processing
	var totalFiles, excludedFiles, dirs int
	err := filepath.Walk(s.service.cfg.DataRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // Skip errors
		}

		// Get relative path
		relPath, err := filepath.Rel(s.service.cfg.DataRoot, path)
		if err != nil {
			return nil
		}

		// Skip excluded paths (skip entire directory if excluded)
		if s.service.validator.IsExcluded(relPath) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			excludedFiles++
			return nil
		}

		// Skip directories (after exclusion check)
		if info.IsDir() {
			dirs++
			return nil
		}

		totalFiles++
		seenPaths[relPath] = true // Track this file as seen on disk

		// Check if file needs processing
		needsProcessing, reason := s.checkNeedsProcessing(relPath, info)
		if needsProcessing {
			filesToProcess = append(filesToProcess, fileToProcess{
				path:   relPath,
				info:   info,
				reason: reason,
			})
		}

		return nil
	})

	if err != nil {
		log.Error().Err(err).Msg("scan walk error")
		return
	}

	log.Info().
		Int("totalFiles", totalFiles).
		Int("filesNeedingProcessing", len(filesToProcess)).
		Dur("walkDuration", time.Since(startTime)).
		Msg("filesystem walk complete, processing files")

	// Process files that need updates (in parallel with bounded concurrency)
	if len(filesToProcess) > 0 {
		s.processFiles(filesToProcess)
	}

	// Phase 2: Reconcile - remove orphaned DB records
	orphansRemoved := s.reconcileOrphans(seenPaths)

	// Cleanup stale lock entries to prevent memory leaks
	if cleaned := s.service.fileLock.cleanupStale(); cleaned > 0 {
		log.Info().
			Int("cleanedLocks", cleaned).
			Msg("cleaned up stale file locks")
	}

	// Check for files missing previews (backfill for pre-existing files)
	s.service.preview.queueMissingPreviews()

	log.Info().
		Int("totalFiles", totalFiles).
		Int("filesProcessed", len(filesToProcess)).
		Int("orphansRemoved", orphansRemoved).
		Dur("totalDuration", time.Since(startTime)).
		Msg("filesystem scan complete")
}

// fileToProcess represents a file that needs processing
type fileToProcess struct {
	path   string
	info   os.FileInfo
	reason string
}

// checkNeedsProcessing determines if a file needs processing
func (s *scanner) checkNeedsProcessing(path string, info os.FileInfo) (bool, string) {
	// Get database record
	record, err := s.service.cfg.DB.GetFileByPath(path)
	if err != nil || record == nil {
		return true, "not_in_db"
	}

	// Check if hash is missing
	if record.Hash == nil || *record.Hash == "" {
		return true, "missing_hash"
	}

	// Check if modified_at differs (file changed externally)
	fileModTimeMs := info.ModTime().UnixMilli()
	if record.ModifiedAt != fileModTimeMs {
		return true, "modified_time_changed"
	}

	// Check if text preview is missing (and file type supports it)
	if record.TextPreview == nil && s.service.processor.isTextFile(path) {
		return true, "missing_text_preview"
	}

	return false, "" // File is up to date
}

// processFiles processes multiple files concurrently with bounded concurrency
func (s *scanner) processFiles(files []fileToProcess) {
	// Use worker pool to limit concurrency
	sem := make(chan struct{}, maxScanConcurrency)
	var wg sync.WaitGroup

	processed := 0
	failed := 0
	var counterMu sync.Mutex

	for _, file := range files {
		wg.Add(1)
		go func(f fileToProcess) {
			defer wg.Done()

			// Acquire semaphore
			sem <- struct{}{}
			defer func() { <-sem }() // Release

			// Acquire per-file mutex (same as API uses) to coordinate with API operations.
			// This ensures that if an API call is writing to a file, the scanner will wait,
			// and vice versa. This prevents race conditions where scanner overwrites newer data.
			fileMu := s.service.fileLock.acquireFileLock(f.path)
			fileMu.Lock()
			defer fileMu.Unlock()

			// Process file
			if err := s.processFile(f); err != nil {
				log.Warn().
					Err(err).
					Str("path", f.path).
					Str("reason", f.reason).
					Msg("failed to process file during scan")
				counterMu.Lock()
				failed++
				counterMu.Unlock()
			} else {
				counterMu.Lock()
				processed++
				counterMu.Unlock()
			}
		}(file)
	}

	wg.Wait()

	log.Info().
		Int("processed", processed).
		Int("failed", failed).
		Int("total", len(files)).
		Msg("scan processing complete")
}

// reconcileOrphans removes DB records for files that no longer exist on disk.
// This handles files deleted or moved while the server was stopped.
// Returns the number of orphaned records removed.
func (s *scanner) reconcileOrphans(seenPaths map[string]bool) int {
	// Get all file paths from database
	dbPaths, err := s.service.cfg.DB.ListAllFilePaths()
	if err != nil {
		log.Error().Err(err).Msg("failed to list file paths from database for reconciliation")
		return 0
	}

	// Find orphans (in DB but not on disk)
	var orphans []string
	for _, dbPath := range dbPaths {
		if !seenPaths[dbPath] {
			orphans = append(orphans, dbPath)
		}
	}

	if len(orphans) == 0 {
		return 0
	}

	log.Info().
		Int("count", len(orphans)).
		Msg("found orphaned DB records, removing")

	// Delete orphans with cascade (removes related digests, pins)
	removed := 0
	for _, path := range orphans {
		if err := s.service.cfg.DB.DeleteFileWithCascade(path); err != nil {
			log.Warn().
				Err(err).
				Str("path", path).
				Msg("failed to delete orphaned record")
			continue
		}

		log.Info().
			Str("path", path).
			Msg("removed orphaned DB record")
		removed++

		// Release any file locks for this path
		s.service.fileLock.releaseFileLock(path)
	}

	return removed
}

// processFile processes a single file during scan
func (s *scanner) processFile(f fileToProcess) error {
	// Get existing record (for change detection)
	existing, _ := s.service.cfg.DB.GetFileByPath(f.path)
	oldHash := ""
	if existing != nil && existing.Hash != nil {
		oldHash = *existing.Hash
	}

	// Compute metadata
	metadata, err := s.service.processor.ComputeMetadata(context.Background(), f.path)
	if err != nil {
		log.Error().
			Err(err).
			Str("path", f.path).
			Msg("failed to compute metadata during scan")
		return err
	}

	// Create/update database record with metadata
	record := s.service.buildFileRecord(f.path, f.info, metadata)
	isNew, err := s.service.cfg.DB.UpsertFile(record)
	if err != nil {
		return err
	}

	// Detect content change
	newHash := metadata.Hash
	contentChanged := (oldHash == "" && newHash != "") || (oldHash != "" && oldHash != newHash)

	// Notify digest service if content changed
	if contentChanged {
		log.Info().
			Str("path", f.path).
			Bool("isNew", isNew).
			Str("reason", f.reason).
			Msg("scan detected content change, notifying digest service")

		s.service.notifyFileChange(FileChangeEvent{
			FilePath:       f.path,
			IsNew:          isNew,
			ContentChanged: true,
			Trigger:        "scan",
		})
	}

	log.Debug().
		Str("path", f.path).
		Bool("isNew", isNew).
		Str("reason", f.reason).
		Msg("file processed during scan")

	return nil
}
