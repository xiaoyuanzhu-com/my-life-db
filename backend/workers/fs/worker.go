package fs

import (
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

// FileChangeEvent represents a file system change
type FileChangeEvent struct {
	FilePath       string
	IsNew          bool
	ContentChanged bool
}

// FileChangeHandler is called when files change
type FileChangeHandler func(event FileChangeEvent)

// Default exclusion patterns for filesystem scanning
var defaultExclusionPatterns = []string{
	`^app/`,           // App data directory
	`^\.git/`,         // Git repository
	`/\.git/`,         // Git repository in subdirectories
	`(^|/)\.DS_Store$`, // macOS metadata files (anywhere)
	`(^|/)\..*\.swp$`, // Vim swap files
	`(^|/)~.*$`,       // Backup files
}

// Worker watches the file system for changes
type Worker struct {
	dataRoot          string
	watcher           *fsnotify.Watcher
	onChange          FileChangeHandler
	stopChan          chan struct{}
	wg                sync.WaitGroup
	scanInterval      time.Duration
	lastScanTimes     map[string]time.Time
	mu                sync.RWMutex
	exclusionPatterns []*regexp.Regexp
}

var (
	instance     *Worker
	instanceOnce sync.Once
)

// GetWorker returns the singleton FS worker instance
func GetWorker() *Worker {
	return instance
}

// NewWorker creates a new file system worker
func NewWorker(dataRoot string) *Worker {
	// Compile exclusion patterns
	exclusionPatterns := make([]*regexp.Regexp, 0, len(defaultExclusionPatterns))
	for _, pattern := range defaultExclusionPatterns {
		re, err := regexp.Compile(pattern)
		if err != nil {
			log.Warn().Err(err).Str("pattern", pattern).Msg("failed to compile exclusion pattern")
			continue
		}
		exclusionPatterns = append(exclusionPatterns, re)
	}

	w := &Worker{
		dataRoot:          dataRoot,
		stopChan:          make(chan struct{}),
		scanInterval:      1 * time.Hour,
		lastScanTimes:     make(map[string]time.Time),
		exclusionPatterns: exclusionPatterns,
	}
	// Set as singleton instance
	instanceOnce.Do(func() {
		instance = w
	})
	return w
}

// SetFileChangeHandler sets the callback for file changes
func (w *Worker) SetFileChangeHandler(handler FileChangeHandler) {
	w.onChange = handler
}

// ProcessFile processes a single file's metadata (for API endpoints)
// Returns true if the file content changed (hash differs from existing)
func (w *Worker) ProcessFile(relPath string) (bool, error) {
	// Get file info
	fullPath := filepath.Join(w.dataRoot, relPath)
	info, err := os.Stat(fullPath)
	if err != nil {
		return false, err
	}

	// Get existing record to check for hash change
	existing, _ := db.GetFileByPath(relPath)
	oldHash := ""
	if existing != nil && existing.Hash != nil {
		oldHash = *existing.Hash
	}

	// Process and update file record
	w.createFileRecord(relPath, info)

	// Check if hash changed
	updated, _ := db.GetFileByPath(relPath)
	if updated != nil && updated.Hash != nil {
		return oldHash != *updated.Hash, nil
	}

	return false, nil
}

// Start begins watching the file system
func (w *Worker) Start() error {
	var err error
	w.watcher, err = fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	log.Info().Str("dataRoot", w.dataRoot).Msg("starting file system worker")

	// Watch the data root directory recursively
	if err := w.watchRecursive(w.dataRoot); err != nil {
		log.Error().Err(err).Msg("failed to watch data directory")
	}

	// Start the watch loop
	w.wg.Add(1)
	go w.watchLoop()

	// Start periodic scanner
	w.wg.Add(1)
	go w.scanLoop()

	// Initial scan after 10 seconds
	time.AfterFunc(10*time.Second, func() {
		w.scanDirectory(w.dataRoot)
	})

	return nil
}

// Stop stops the file system worker
func (w *Worker) Stop() {
	close(w.stopChan)
	if w.watcher != nil {
		w.watcher.Close()
	}
	w.wg.Wait()
	log.Info().Msg("file system worker stopped")
}

// watchRecursive adds all directories under root to the watcher
func (w *Worker) watchRecursive(root string) error {
	return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // Skip errors
		}

		// Skip reserved directories
		relPath, _ := filepath.Rel(w.dataRoot, path)
		if w.isExcluded(relPath) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if info.IsDir() {
			if err := w.watcher.Add(path); err != nil {
				log.Warn().Err(err).Str("path", path).Msg("failed to watch directory")
			}
		}

		return nil
	})
}

// isExcluded checks if a path matches any exclusion pattern
func (w *Worker) isExcluded(relPath string) bool {
	for _, pattern := range w.exclusionPatterns {
		if pattern.MatchString(relPath) {
			return true
		}
	}
	return false
}

// watchLoop processes file system events
func (w *Worker) watchLoop() {
	defer w.wg.Done()

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

// handleEvent processes a single file system event
func (w *Worker) handleEvent(event fsnotify.Event) {
	relPath, err := filepath.Rel(w.dataRoot, event.Name)
	if err != nil {
		return
	}

	// Skip reserved paths
	if w.isExcluded(relPath) {
		return
	}

	// Determine event type
	isNew := event.Op&fsnotify.Create != 0
	contentChanged := event.Op&fsnotify.Write != 0

	// Add new directories to watcher
	if isNew {
		info, err := os.Stat(event.Name)
		if err == nil && info.IsDir() {
			w.watcher.Add(event.Name)
		}
	}

	// Skip directory events for onChange
	info, err := os.Stat(event.Name)
	if err != nil || info.IsDir() {
		return
	}

	// Create or update database record for new files (unified handling)
	if isNew {
		w.createFileRecord(relPath, info)
	}

	// Notify handler
	if w.onChange != nil && (isNew || contentChanged) {
		w.onChange(FileChangeEvent{
			FilePath:       relPath,
			IsNew:          isNew,
			ContentChanged: contentChanged,
		})
	}
}

// createFileRecord creates or updates a database record for a file detected by the FS watcher
// This ensures files added externally (AirDrop, direct copy) are tracked in the database
// Also computes hash and text preview for the file
func (w *Worker) createFileRecord(relPath string, info os.FileInfo) {
	now := db.NowUTC()
	filename := filepath.Base(relPath)
	mimeType := utils.DetectMimeType(filename)
	size := info.Size()

	// Get existing record to check for hash change
	existing, _ := db.GetFileByPath(relPath)
	oldHash := ""
	if existing != nil && existing.Hash != nil {
		oldHash = *existing.Hash
	}

	// Compute metadata (hash + text preview)
	metadata, err := ProcessFileMetadata(relPath)
	if err != nil {
		log.Error().
			Err(err).
			Str("path", relPath).
			Msg("failed to process file metadata")

		// Fall back to basic record without hash/preview
		err = db.UpsertFile(&db.FileRecord{
			Path:          relPath,
			Name:          filename,
			IsFolder:      false,
			Size:          &size,
			MimeType:      &mimeType,
			ModifiedAt:    now,
			CreatedAt:     now,
			LastScannedAt: now,
		})

		if err != nil {
			log.Error().
				Err(err).
				Str("path", relPath).
				Msg("failed to create file record")
		}
		return
	}

	// Create file record with hash and text preview
	err = db.UpsertFile(&db.FileRecord{
		Path:          relPath,
		Name:          filename,
		IsFolder:      false,
		Size:          &size,
		MimeType:      &mimeType,
		Hash:          &metadata.Hash,
		TextPreview:   metadata.TextPreview,
		ModifiedAt:    now,
		CreatedAt:     now,
		LastScannedAt: now,
	})

	if err != nil {
		log.Error().
			Err(err).
			Str("path", relPath).
			Msg("failed to create file record")
		return
	}

	log.Info().
		Str("path", relPath).
		Int64("size", size).
		Str("mimeType", mimeType).
		Str("hash", metadata.Hash[:16]+"...").
		Bool("hasPreview", metadata.TextPreview != nil).
		Msg("created file record with metadata")

	// Check if content changed (hash differs)
	contentChanged := oldHash == "" || oldHash != metadata.Hash

	// Trigger digest processing if content changed
	if contentChanged && w.onChange != nil {
		log.Info().Str("path", relPath).Msg("content changed, triggering digest processing")
		w.onChange(FileChangeEvent{
			FilePath:       relPath,
			IsNew:          oldHash == "",
			ContentChanged: true,
		})
	}
}

// scanLoop runs periodic scans
func (w *Worker) scanLoop() {
	defer w.wg.Done()

	ticker := time.NewTicker(w.scanInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			w.scanDirectory(w.dataRoot)
		case <-w.stopChan:
			return
		}
	}
}

// scanDirectory scans a directory for files
func (w *Worker) scanDirectory(root string) {
	log.Info().Str("root", root).Msg("starting directory scan")

	count := 0
	processed := 0

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}

		relPath, _ := filepath.Rel(w.dataRoot, path)

		// Skip reserved paths
		if w.isExcluded(relPath) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if !info.IsDir() {
			count++

			// Create/update database record for ALL files during scan
			w.createFileRecord(relPath, info)
			processed++
		}

		return nil
	})

	if err != nil {
		log.Error().Err(err).Msg("scan error")
	}

	log.Info().
		Int("total", count).
		Int("processed", processed).
		Msg("directory scan complete")
}
