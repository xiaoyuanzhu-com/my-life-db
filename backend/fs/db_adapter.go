package fs

import (
	"github.com/xiaoyuanzhu-com/my-life-db/db"
)

// dbAdapter adapts the existing db package to the fs.Database interface
type dbAdapter struct{}

// NewDBAdapter creates a new database adapter
func NewDBAdapter() Database {
	return &dbAdapter{}
}

// GetFileByPath retrieves a file record by path
func (a *dbAdapter) GetFileByPath(path string) (*db.FileRecord, error) {
	return db.GetFileByPath(path)
}

// UpsertFile inserts or updates a file record
func (a *dbAdapter) UpsertFile(record *db.FileRecord) (bool, error) {
	return db.UpsertFile(record)
}

// DeleteFile removes a file record
func (a *dbAdapter) DeleteFile(path string) error {
	return db.DeleteFile(path)
}

// UpdateFileField updates a single field on a file record
func (a *dbAdapter) UpdateFileField(path string, field string, value interface{}) error {
	return db.UpdateFileField(path, field, value)
}

// MoveFileAtomic atomically moves a file record from oldPath to newPath
func (a *dbAdapter) MoveFileAtomic(oldPath, newPath string, record *db.FileRecord) error {
	return db.MoveFileAtomic(oldPath, newPath, record)
}
