package digest

import (
	"database/sql"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
)

// DigestStatus represents the status of a digest
type DigestStatus string

const (
	DigestStatusTodo       DigestStatus = "todo"
	DigestStatusInProgress DigestStatus = "in-progress"
	DigestStatusCompleted  DigestStatus = "completed"
	DigestStatusSkipped    DigestStatus = "skipped"
	DigestStatusFailed     DigestStatus = "failed"
)

// MaxDigestAttempts is the maximum number of retry attempts
const MaxDigestAttempts = 3

// DigestInput represents input for creating/updating a digest
type DigestInput struct {
	ID        string
	FilePath  string
	Digester  string
	Status    DigestStatus
	Content   *string
	SqlarName *string
	SqlarData []byte // Binary data to store in SQLAR (if SqlarName is set)
	Error     *string
	Attempts  int
	CreatedAt int64
	UpdatedAt int64
}

// Digester interface - processes files and produces digest outputs
type Digester interface {
	// Name returns the unique digester name
	Name() string

	// Label returns the human-readable label for UI display
	Label() string

	// Description returns what this digester does
	Description() string

	// GetOutputDigesters returns the list of digest records this digester produces
	// Returns empty/nil to use the digester name
	GetOutputDigesters() []string

	// CanDigest checks if this digester applies to the given file type
	CanDigest(filePath string, file *db.FileRecord, dbConn *sql.DB) (bool, error)

	// Digest executes the digest operation
	Digest(filePath string, file *db.FileRecord, existingDigests []db.Digest, dbConn *sql.DB) ([]DigestInput, error)
}

// CascadingResets defines which digesters to reset when an upstream digester completes
var CascadingResets = map[string][]string{
	"url-crawl-content":     {"url-crawl-summary", "tags", "search-keyword", "search-semantic"},
	"doc-to-markdown":       {"tags", "search-keyword", "search-semantic"},
	"image-ocr":             {"tags", "search-keyword", "search-semantic"},
	"image-captioning":      {"tags", "search-keyword", "search-semantic"},
	"image-objects":         {"tags", "search-keyword", "search-semantic"},
	"speech-recognition":    {"speaker-embedding", "speech-recognition-cleanup", "speech-recognition-summary", "tags", "search-keyword", "search-semantic"},
	"url-crawl-summary":     {"tags"},
	"speech-recognition-summary": {"tags", "search-keyword", "search-semantic"},
	"tags":                  {"search-keyword", "search-semantic"},
}
