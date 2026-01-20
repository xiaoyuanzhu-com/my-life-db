package fs

import (
	"context"
	"io"
	"sync"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Service coordinates all filesystem operations
type Service struct {
	// Configuration
	cfg Config

	// Sub-components
	validator *validator
	processor *metadataProcessor
	watcher   *watcher
	scanner   *scanner

	// Concurrency control
	fileLock *fileLock

	// File change notification
	changeHandler FileChangeHandler
	handlerMu     sync.RWMutex

	// Lifecycle
	stopChan chan struct{}
	wg       sync.WaitGroup
}

// NewService creates a new filesystem service
func NewService(cfg Config) *Service {
	s := &Service{
		cfg:       cfg,
		validator: newValidator(),
		fileLock:  &fileLock{},
		stopChan:  make(chan struct{}),
	}

	// Initialize sub-components
	s.processor = newMetadataProcessor(s)

	// Only create watcher if enabled
	if cfg.WatchEnabled {
		s.watcher = newWatcher(s)
	}

	s.scanner = newScanner(s, cfg.ScanInterval)

	return s
}

// Start begins background processes (watching, scanning)
func (s *Service) Start() error {
	log.Info().Str("dataRoot", s.cfg.DataRoot).Msg("starting filesystem service")

	// Start watcher if enabled
	if s.watcher != nil {
		if err := s.watcher.Start(); err != nil {
			return err
		}
	}

	// Start scanner
	if err := s.scanner.Start(); err != nil {
		return err
	}

	log.Info().Msg("filesystem service started")
	return nil
}

// Stop gracefully shuts down the service
func (s *Service) Stop() error {
	log.Info().Msg("stopping filesystem service")

	close(s.stopChan)

	// Stop sub-components
	s.watcher.Stop()
	s.scanner.Stop()

	// Wait for all goroutines
	s.wg.Wait()

	log.Info().Msg("filesystem service stopped")
	return nil
}

// SetFileChangeHandler registers callback for file changes (used by digest service)
func (s *Service) SetFileChangeHandler(handler FileChangeHandler) {
	s.handlerMu.Lock()
	defer s.handlerMu.Unlock()
	s.changeHandler = handler
}

// notifyFileChange calls the registered change handler (if any)
func (s *Service) notifyFileChange(event FileChangeEvent) {
	s.handlerMu.RLock()
	handler := s.changeHandler
	s.handlerMu.RUnlock()

	if handler != nil {
		// Call handler in goroutine to avoid blocking
		go handler(event)
	}
}

// ValidatePath checks if path is valid and not excluded
func (s *Service) ValidatePath(path string) error {
	return s.validator.ValidatePath(path)
}

// GetFileInfo retrieves file metadata from database
func (s *Service) GetFileInfo(ctx context.Context, path string) (*db.FileRecord, error) {
	if err := s.ValidatePath(path); err != nil {
		return nil, err
	}

	return s.cfg.DB.GetFileByPath(path)
}

// WriteFile creates or updates a file with content
func (s *Service) WriteFile(ctx context.Context, req WriteRequest) (*WriteResult, error) {
	// Implementation in operations.go
	return s.writeFile(ctx, req)
}

// ReadFile reads a file's content
func (s *Service) ReadFile(ctx context.Context, path string) (io.ReadCloser, error) {
	// Implementation in operations.go
	return s.readFile(ctx, path)
}

// DeleteFile removes a file from filesystem and database
func (s *Service) DeleteFile(ctx context.Context, path string) error {
	// Implementation in operations.go
	return s.deleteFile(ctx, path)
}

// MoveFile moves a file from src to dst
func (s *Service) MoveFile(ctx context.Context, src, dst string) error {
	// Implementation in operations.go
	return s.moveFile(ctx, src, dst)
}

// ProcessMetadata computes hash and text preview for existing file
func (s *Service) ProcessMetadata(ctx context.Context, path string) (*MetadataResult, error) {
	if err := s.ValidatePath(path); err != nil {
		return nil, err
	}

	return s.processor.ComputeMetadata(ctx, path)
}
