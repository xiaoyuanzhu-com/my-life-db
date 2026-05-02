package fs

import (
	"context"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
)

// dbAdapter implements the fs.Database interface by delegating to a *db.DB.
type dbAdapter struct {
	db *db.DB
}

// NewDBAdapter creates a new database adapter backed by the given *db.DB.
func NewDBAdapter(d *db.DB) Database {
	return &dbAdapter{db: d}
}

// GetFileByPath retrieves a file record by path
func (a *dbAdapter) GetFileByPath(path string) (*db.FileRecord, error) {
	return a.db.GetFileByPath(path)
}

// UpsertFile inserts or updates a file record
func (a *dbAdapter) UpsertFile(record *db.FileRecord) (bool, error) {
	return a.db.UpsertFile(context.Background(), record)
}

// DeleteFile removes a file record
func (a *dbAdapter) DeleteFile(path string) error {
	return a.db.DeleteFile(context.Background(), path)
}

// UpdateFileField updates a single field on a file record
func (a *dbAdapter) UpdateFileField(path string, field string, value interface{}) error {
	return a.db.UpdateFileField(context.Background(), path, field, value)
}

// MoveFileAtomic atomically moves a file record from oldPath to newPath
func (a *dbAdapter) MoveFileAtomic(oldPath, newPath string, record *db.FileRecord) error {
	return a.db.MoveFileAtomic(context.Background(), oldPath, newPath, record)
}

// ListAllFilePaths returns all file paths in the database (for reconciliation)
func (a *dbAdapter) ListAllFilePaths() ([]string, error) {
	return a.db.ListAllFilePaths()
}

// RenameFilePath updates a single file's path and name, including all related tables
func (a *dbAdapter) RenameFilePath(oldPath, newPath, newName string) error {
	return a.db.RenameFilePath(context.Background(), oldPath, newPath, newName)
}

// RenameFilePaths updates all paths that start with oldPath prefix (for folder renames)
func (a *dbAdapter) RenameFilePaths(oldPath, newPath string) error {
	return a.db.RenameFilePaths(context.Background(), oldPath, newPath)
}

// DeleteFileWithCascade removes a file and all related records (digests, pins)
func (a *dbAdapter) DeleteFileWithCascade(path string) error {
	return a.db.DeleteFileWithCascade(context.Background(), path)
}

// BatchDeleteFilesWithCascade removes multiple files and related records in one transaction
func (a *dbAdapter) BatchDeleteFilesWithCascade(paths []string) error {
	return a.db.BatchDeleteFilesWithCascade(context.Background(), paths)
}

// DeleteFilesWithCascadePrefix removes a folder and all files/records under it
func (a *dbAdapter) DeleteFilesWithCascadePrefix(pathPrefix string) error {
	return a.db.DeleteFilesWithCascadePrefix(context.Background(), pathPrefix)
}

// GetFilesMissingPreviews returns files that need preview generation
func (a *dbAdapter) GetFilesMissingPreviews(limit int) ([]db.FileWithMime, error) {
	return a.db.GetFilesMissingPreviews(limit)
}

// SqlarStore stores data in the SQLAR table
func (a *dbAdapter) SqlarStore(name string, data []byte, mode int) bool {
	return db.SqlarStore(name, data, mode)
}

// SqlarExists checks if a name exists in the SQLAR table
func (a *dbAdapter) SqlarExists(name string) bool {
	return db.SqlarExists(name)
}
