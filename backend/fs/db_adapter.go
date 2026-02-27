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

// ListAllFilePaths returns all file paths in the database (for reconciliation)
func (a *dbAdapter) ListAllFilePaths() ([]string, error) {
	return db.ListAllFilePaths()
}

// RenameFilePath updates a single file's path and name, including all related tables
func (a *dbAdapter) RenameFilePath(oldPath, newPath, newName string) error {
	return db.RenameFilePath(oldPath, newPath, newName)
}

// RenameFilePaths updates all paths that start with oldPath prefix (for folder renames)
func (a *dbAdapter) RenameFilePaths(oldPath, newPath string) error {
	return db.RenameFilePaths(oldPath, newPath)
}

// DeleteFileWithCascade removes a file and all related records (digests, pins)
func (a *dbAdapter) DeleteFileWithCascade(path string) error {
	return db.DeleteFileWithCascade(path)
}

// DeleteFilesWithCascadePrefix removes a folder and all files/records under it
func (a *dbAdapter) DeleteFilesWithCascadePrefix(pathPrefix string) error {
	return db.DeleteFilesWithCascadePrefix(pathPrefix)
}

// GetFilesMissingPreviews returns files that need preview generation
func (a *dbAdapter) GetFilesMissingPreviews(limit int) ([]db.FileWithMime, error) {
	return db.GetFilesMissingPreviews(limit)
}

// SqlarStore stores data in the SQLAR table
func (a *dbAdapter) SqlarStore(name string, data []byte, mode int) bool {
	return db.SqlarStore(name, data, mode)
}

// SqlarExists checks if a name exists in the SQLAR table
func (a *dbAdapter) SqlarExists(name string) bool {
	return db.SqlarExists(name)
}
