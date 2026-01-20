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

// scan performs a full filesystem scan
func (s *scanner) scan() {
	log.Info().Str("root", s.service.cfg.DataRoot).Msg("starting filesystem scan")

	// Check if data root exists
	if stat, err := os.Stat(s.service.cfg.DataRoot); err != nil {
		log.Error().Err(err).Str("root", s.service.cfg.DataRoot).Msg("DEBUG SCAN: data root stat failed")
		return
	} else {
		log.Info().
			Str("root", s.service.cfg.DataRoot).
			Bool("isDir", stat.IsDir()).
			Msg("DEBUG SCAN: data root exists")
	}

	startTime := time.Now()

	var filesToProcess []fileToProcess

	// 1. Walk filesystem and identify files needing processing
	var totalFiles, excludedFiles, dirs int
	log.Info().Str("root", s.service.cfg.DataRoot).Msg("DEBUG SCAN: starting filepath.Walk")
	err := filepath.Walk(s.service.cfg.DataRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			log.Warn().Err(err).Str("path", path).Msg("DEBUG SCAN: walk error for path")
			return nil // Skip errors
		}

		// Get relative path
		relPath, err := filepath.Rel(s.service.cfg.DataRoot, path)
		if err != nil {
			return nil
		}

		// Skip excluded paths (skip entire directory if excluded)
		if s.service.validator.isExcluded(relPath) {
			log.Info().Str("path", relPath).Msg("DEBUG SCAN: excluded path")
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
		log.Info().Str("path", relPath).Msg("DEBUG SCAN: evaluating file")

		// Check if file needs processing
		needsProcessing, reason := s.checkNeedsProcessing(relPath, info)
		if needsProcessing {
			log.Info().Str("path", relPath).Str("reason", reason).Msg("DEBUG SCAN: FILE NEEDS PROCESSING")
			filesToProcess = append(filesToProcess, fileToProcess{
				path:   relPath,
				info:   info,
				reason: reason,
			})
		}

		return nil
	})

	log.Info().Msg("DEBUG SCAN: filepath.Walk completed")

	if err != nil {
		log.Error().Err(err).Msg("scan walk error")
		return
	}

	log.Info().
		Int("filesNeedingProcessing", len(filesToProcess)).
		Int("totalFiles", totalFiles).
		Int("excludedFiles", excludedFiles).
		Int("dirs", dirs).
		Dur("walkDuration", time.Since(startTime)).
		Msg("filesystem walk complete, processing files")

	// 2. Process files that need updates (in parallel with bounded concurrency)
	if len(filesToProcess) > 0 {
		s.processFiles(filesToProcess)
	}

	log.Info().
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
		log.Info().Str("path", path).Msg("DEBUG: not_in_db")
		return true, "not_in_db"
	}

	// Check if hash is missing
	if record.Hash == nil || *record.Hash == "" {
		log.Info().Str("path", path).Msg("DEBUG: missing_hash")
		return true, "missing_hash"
	}

	// Check if modified_at differs (file changed externally)
	fileModTime := info.ModTime().UTC().Format(time.RFC3339)
	log.Info().
		Str("path", path).
		Str("fileModTime", fileModTime).
		Str("recordModTime", record.ModifiedAt).
		Bool("timesMatch", fileModTime == record.ModifiedAt).
		Msg("DEBUG: checking modified_at")
	if record.ModifiedAt != fileModTime {
		return true, "modified_time_changed"
	}

	// Check if text preview is missing (and file type supports it)
	isTextFile := s.service.processor.isTextFile(path)
	hasPreview := record.TextPreview != nil
	log.Info().
		Str("path", path).
		Bool("isTextFile", isTextFile).
		Bool("hasPreview", hasPreview).
		Msg("DEBUG: checking text_preview")
	if record.TextPreview == nil && s.service.processor.isTextFile(path) {
		return true, "missing_text_preview"
	}

	log.Info().Str("path", path).Msg("DEBUG: file is up to date, skipping")
	return false, "" // File is up to date
}

// processFiles processes multiple files concurrently with bounded concurrency
func (s *scanner) processFiles(files []fileToProcess) {
	// Use worker pool to limit concurrency
	sem := make(chan struct{}, maxScanConcurrency)
	var wg sync.WaitGroup

	processed := 0
	failed := 0
	var mu sync.Mutex

	for _, file := range files {
		wg.Add(1)
		go func(f fileToProcess) {
			defer wg.Done()

			// Acquire semaphore
			sem <- struct{}{}
			defer func() { <-sem }() // Release

			// Check if already being processed
			if s.service.fileLock.isProcessing(f.path) {
				log.Info().
					Str("path", f.path).
					Msg("file already being processed, skipping scan")
				return
			}

			// Mark as processing
			if !s.service.fileLock.markProcessing(f.path) {
				return
			}
			defer s.service.fileLock.unmarkProcessing(f.path)

			// Process file
			if err := s.processFile(f); err != nil {
				log.Warn().
					Err(err).
					Str("path", f.path).
					Str("reason", f.reason).
					Msg("failed to process file during scan")
				mu.Lock()
				failed++
				mu.Unlock()
			} else {
				mu.Lock()
				processed++
				mu.Unlock()
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

// processFile processes a single file during scan
func (s *scanner) processFile(f fileToProcess) error {
	log.Info().Str("path", f.path).Str("reason", f.reason).Msg("DEBUG SCAN: processFile starting")

	// Get existing record (for change detection)
	existing, _ := s.service.cfg.DB.GetFileByPath(f.path)
	oldHash := ""
	if existing != nil && existing.Hash != nil {
		oldHash = *existing.Hash
	}

	// Compute metadata
	log.Info().Str("path", f.path).Msg("DEBUG SCAN: computing metadata")
	metadata, err := s.service.processor.ComputeMetadata(context.Background(), f.path)
	if err != nil {
		log.Error().
			Err(err).
			Str("path", f.path).
			Msg("failed to compute metadata during scan")
		return err
	}

	log.Info().
		Str("path", f.path).
		Str("hash", metadata.Hash).
		Bool("hasTextPreview", metadata.TextPreview != nil).
		Msg("DEBUG SCAN: metadata computed")

	// Create/update database record with metadata
	record := s.service.buildFileRecord(f.path, f.info, metadata)
	isNew, err := s.service.cfg.DB.UpsertFile(record)
	if err != nil {
		log.Error().Err(err).Str("path", f.path).Msg("DEBUG SCAN: upsert failed")
		return err
	}

	log.Info().
		Str("path", f.path).
		Bool("isNew", isNew).
		Msg("DEBUG SCAN: file upserted to database")

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

	log.Info().
		Str("path", f.path).
		Bool("isNew", isNew).
		Str("reason", f.reason).
		Msg("file processed during scan")

	return nil
}
