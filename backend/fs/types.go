package fs

import (
	"io"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
)

// WriteRequest specifies how to write a file
type WriteRequest struct {
	Path            string    // Relative path from data root
	Content         io.Reader // File content
	MimeType        string    // Optional, auto-detected if empty
	Source          string    // "api", "upload", "external" (for logging)
	ComputeMetadata bool      // Compute hash + preview immediately?
	Sync            bool      // Wait for metadata or async?
}

// WriteResult contains information about the write operation
type WriteResult struct {
	Record       *db.FileRecord // Database record
	IsNew        bool           // Was this a new file?
	HashComputed bool           // Was hash computed?
	Error        error          // Any non-fatal errors (e.g., metadata computation failed)
}

// MetadataResult contains computed file metadata
type MetadataResult struct {
	Hash        string  // SHA-256 hex
	TextPreview *string // First 60 lines of text (if applicable)
	Size        int64   // File size in bytes
}

// FileChangeEvent notifies about file system changes
type FileChangeEvent struct {
	FilePath       string
	IsNew          bool
	ContentChanged bool   // Hash differs from previous
	Trigger        string // "fsnotify", "api", "scan"
}

// FileChangeHandler is called when files change (used by digest service)
type FileChangeHandler func(event FileChangeEvent)

// Config contains configuration for the FS service
type Config struct {
	DataRoot     string
	DB           Database
	ScanInterval time.Duration // How often to scan for external changes
	WatchEnabled bool          // Enable filesystem watching
}

// Database interface defines required database operations
// This allows for easier testing and decoupling
type Database interface {
	GetFileByPath(path string) (*db.FileRecord, error)
	UpsertFile(record *db.FileRecord) (bool, error)
	DeleteFile(path string) error
	UpdateFileField(path string, field string, value interface{}) error
	MoveFileAtomic(oldPath, newPath string, record *db.FileRecord) error
	// Reconciliation methods
	ListAllFilePaths() ([]string, error)
	DeleteFileWithCascade(path string) error
}
