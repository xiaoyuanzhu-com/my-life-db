package db

import (
	"database/sql"
	"time"
)

// FileRecord represents a file in the database
type FileRecord struct {
	Path           string     `json:"path"`
	Name           string     `json:"name"`
	IsFolder       bool       `json:"isFolder"`
	Size           *int64     `json:"size,omitempty"`
	MimeType       *string    `json:"mimeType,omitempty"`
	Hash           *string    `json:"hash,omitempty"`
	ModifiedAt     int64      `json:"modifiedAt"`
	CreatedAt      int64      `json:"createdAt"`
	LastScannedAt  int64      `json:"lastScannedAt,omitempty"`
	TextPreview    *string    `json:"textPreview,omitempty"`
	ScreenshotSqlar *string   `json:"screenshotSqlar,omitempty"`
}

// Digest represents a digest record
type Digest struct {
	ID        string  `json:"id"`
	FilePath  string  `json:"filePath"`
	Digester  string  `json:"digester"`
	Status    string  `json:"status"`
	Content   *string `json:"content,omitempty"`
	SqlarName *string `json:"sqlarName,omitempty"`
	Error     *string `json:"error,omitempty"`
	Attempts  int     `json:"attempts"`
	CreatedAt int64   `json:"createdAt"`
	UpdatedAt int64   `json:"updatedAt"`
}

// DigestStatus constants
const (
	DigestStatusTodo      = "todo"
	DigestStatusRunning   = "running"
	DigestStatusDone      = "done"
	DigestStatusFailed    = "failed"
	DigestStatusSkipped   = "skipped"
)

// Pin represents a pinned file
type Pin struct {
	Path      string `json:"path"`
	CreatedAt int64  `json:"createdAt"`
}

// Setting represents a settings record
type Setting struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	UpdatedAt int64  `json:"updatedAt,omitempty"`
}

// Person represents a person record
type Person struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
}

// PersonCluster represents a face/voice cluster
type PersonCluster struct {
	ID          string  `json:"id"`
	PeopleID    *string `json:"peopleId,omitempty"`
	ClusterType string  `json:"clusterType"`
	Centroid    []byte  `json:"centroid,omitempty"`
	SampleCount int     `json:"sampleCount"`
	CreatedAt   int64   `json:"createdAt"`
	UpdatedAt   int64   `json:"updatedAt"`
}

// Session represents an authentication session record
type Session struct {
	ID         string `json:"id"`
	CreatedAt  int64  `json:"createdAt"`
	ExpiresAt  int64  `json:"expiresAt"`
	LastUsedAt int64  `json:"lastUsedAt"`
}

// SqlarFile represents a file in the SQLite Archive
type SqlarFile struct {
	Name  string `json:"name"`
	Mode  int    `json:"mode"`
	Mtime int64  `json:"mtime"`
	Size  int    `json:"sz"`
	Data  []byte `json:"-"`
}

// scanFileRecord scans a row into a FileRecord
func scanFileRecord(row interface{ Scan(...any) error }) (FileRecord, error) {
	var f FileRecord
	var isFolder int
	var lastScannedAt sql.NullInt64
	err := row.Scan(
		&f.Path, &f.Name, &isFolder, &f.Size, &f.MimeType,
		&f.Hash, &f.ModifiedAt, &f.CreatedAt, &lastScannedAt,
		&f.TextPreview, &f.ScreenshotSqlar,
	)
	f.IsFolder = isFolder == 1
	f.LastScannedAt = lastScannedAt.Int64
	return f, err
}

// scanDigest scans a row into a Digest
func scanDigest(row interface{ Scan(...any) error }) (Digest, error) {
	var d Digest
	err := row.Scan(
		&d.ID, &d.FilePath, &d.Digester, &d.Status, &d.Content,
		&d.SqlarName, &d.Error, &d.Attempts, &d.CreatedAt, &d.UpdatedAt,
	)
	return d, err
}

// NowUTC returns the current time in RFC3339 format
// Deprecated: Use NowMs() for epoch millisecond timestamps
func NowUTC() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// NowMs returns the current time as Unix milliseconds (int64)
func NowMs() int64 {
	return time.Now().UnixMilli()
}

// NullString converts *string to sql.NullString
func NullString(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}

// StringPtr converts sql.NullString to *string
func StringPtr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	return &ns.String
}

// IntPtr converts sql.NullInt64 to *int64
func IntPtr(ni sql.NullInt64) *int64 {
	if !ni.Valid {
		return nil
	}
	return &ni.Int64
}
