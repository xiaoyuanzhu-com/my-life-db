package fs

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var logger = log.GetLogger("FSWorker")

// FileChangeEvent represents a file system change
type FileChangeEvent struct {
	FilePath       string
	IsNew          bool
	ContentChanged bool
}

// FileChangeHandler is called when files change
type FileChangeHandler func(event FileChangeEvent)

// Worker watches the file system for changes
type Worker struct {
	dataRoot      string
	watcher       *fsnotify.Watcher
	onChange      FileChangeHandler
	stopChan      chan struct{}
	wg            sync.WaitGroup
	scanInterval  time.Duration
	lastScanTimes map[string]time.Time
	mu            sync.RWMutex
}

// NewWorker creates a new file system worker
func NewWorker(dataRoot string) *Worker {
	return &Worker{
		dataRoot:      dataRoot,
		stopChan:      make(chan struct{}),
		scanInterval:  1 * time.Hour,
		lastScanTimes: make(map[string]time.Time),
	}
}

// SetFileChangeHandler sets the callback for file changes
func (w *Worker) SetFileChangeHandler(handler FileChangeHandler) {
	w.onChange = handler
}

// Start begins watching the file system
func (w *Worker) Start() error {
	var err error
	w.watcher, err = fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	logger.Info().Str("dataRoot", w.dataRoot).Msg("starting file system worker")

	// Watch the data root directory recursively
	if err := w.watchRecursive(w.dataRoot); err != nil {
		logger.Error().Err(err).Msg("failed to watch data directory")
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
	logger.Info().Msg("file system worker stopped")
}

// watchRecursive adds all directories under root to the watcher
func (w *Worker) watchRecursive(root string) error {
	return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // Skip errors
		}

		// Skip reserved directories
		relPath, _ := filepath.Rel(w.dataRoot, path)
		if w.isReservedPath(relPath) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if info.IsDir() {
			if err := w.watcher.Add(path); err != nil {
				logger.Warn().Err(err).Str("path", path).Msg("failed to watch directory")
			}
		}

		return nil
	})
}

// isReservedPath checks if a path is in a reserved directory
func (w *Worker) isReservedPath(relPath string) bool {
	// Reserved directories that shouldn't be processed by digesters
	reserved := []string{"app", ".DS_Store", ".git"}
	parts := strings.Split(relPath, string(os.PathSeparator))
	if len(parts) > 0 {
		for _, r := range reserved {
			if parts[0] == r {
				return true
			}
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
			logger.Error().Err(err).Msg("watcher error")

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
	if w.isReservedPath(relPath) {
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

	// Notify handler
	if w.onChange != nil && (isNew || contentChanged) {
		w.onChange(FileChangeEvent{
			FilePath:       relPath,
			IsNew:          isNew,
			ContentChanged: contentChanged,
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
	logger.Info().Str("root", root).Msg("starting directory scan")

	count := 0
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}

		relPath, _ := filepath.Rel(w.dataRoot, path)

		// Skip reserved paths
		if w.isReservedPath(relPath) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if !info.IsDir() {
			count++
			// Could trigger file processing here if needed
		}

		return nil
	})

	if err != nil {
		logger.Error().Err(err).Msg("scan error")
	}

	logger.Info().Int("files", count).Msg("directory scan complete")
}
