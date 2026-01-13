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
func newScanner(service *Service) *scanner {
	return &scanner{
		service:  service,
		interval: defaultScanInterval,
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
	log.Info().Str("root", s.service.dataRoot).Msg("starting filesystem scan")
	startTime := time.Now()

	var filesToProcess []fileToProcess

	// 1. Walk filesystem and identify files needing processing
	err := filepath.Walk(s.service.dataRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // Skip errors
		}

		// Skip directories
		if info.IsDir() {
			return nil
		}

		// Get relative path
		relPath, err := filepath.Rel(s.service.dataRoot, path)
		if err != nil {
			return nil
		}

		// Skip excluded paths
		if s.service.validator.isExcluded(relPath) {
			return nil
		}

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
		Int("filesNeedingProcessing", len(filesToProcess)).
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
	record, err := s.service.db.GetFileByPath(path)
	if err != nil || record == nil {
		return true, "not_in_db"
	}

	// Check if hash is missing
	if record.Hash == nil || *record.Hash == "" {
		return true, "missing_hash"
	}

	// Check if modified_at differs (file changed externally)
	fileModTime := info.ModTime().UTC().Format(time.RFC3339)
	if record.ModifiedAt != fileModTime {
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
				log.Debug().
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
	// Get existing record (for change detection)
	existing, _ := s.service.db.GetFileByPath(f.path)
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
	isNew, err := s.service.db.UpsertFile(record)
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
