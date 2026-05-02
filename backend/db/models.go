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
	PreviewSqlar  *string `json:"previewSqlar,omitempty"`
	PreviewStatus *string `json:"previewStatus,omitempty"`
}

// Preview status constants
const (
	PreviewStatusPending = "pending"
	PreviewStatusReady   = "ready"
	PreviewStatusFailed  = "failed"
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

// Session represents an authentication session record
type Session struct {
	ID         string `json:"id"`
	CreatedAt  int64  `json:"createdAt"`
	ExpiresAt  int64  `json:"expiresAt"`
	LastUsedAt int64  `json:"lastUsedAt"`
}

// Machine represents a registered remote machine
type Machine struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Host        string  `json:"host"`
	Port        int     `json:"port"`
	Username    string  `json:"username"`
	AuthType    string  `json:"authType"`
	SSHKeyPath  *string `json:"sshKeyPath,omitempty"`
	SSHPassword *string `json:"-"` // never serialize
	HasPassword bool    `json:"hasPassword,omitempty"`
	Description *string `json:"description,omitempty"`
	Status      string  `json:"status"`
	LastTestedAt *string `json:"lastTestedAt,omitempty"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

// Machine auth type constants
const (
	MachineAuthKey      = "key"
	MachineAuthPassword = "password"
)

// Machine status constants
const (
	MachineStatusOnline  = "online"
	MachineStatusOffline = "offline"
	MachineStatusUnknown = "unknown"
)

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
		&f.TextPreview, &f.PreviewSqlar, &f.PreviewStatus,
	)
	f.IsFolder = isFolder == 1
	f.LastScannedAt = lastScannedAt.Int64
	return f, err
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
