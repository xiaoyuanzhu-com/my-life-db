package fs

import (
	"context"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
)

// dbAdapter implements the fs.Database interface by delegating to the index
// DB. File-mutation methods (DeleteFileWithCascade, RenameFilePath, ...) are
// fully atomic across the index DB and the app DB: the index DB's writer
// connection ATTACHes app.sqlite read-write as 'app', so a single SQL
// transaction can DELETE/UPDATE files, files_fts AND app.pins. No
// orphan pins on crash, no second-transaction follow-up.
type dbAdapter struct {
	indexDB *db.DB // files, sqlar, files_fts; cross-DB writes also touch app.pins via ATTACH rw
}

// NewDBAdapter creates a new database adapter. indexDB hosts the file index
// tables and is the only DB the adapter needs — pin operations happen inside
// the index writer's transactions automatically via app.pins.
func NewDBAdapter(indexDB *db.DB) Database {
	return &dbAdapter{indexDB: indexDB}
}

// GetFileByPath retrieves a file record by path
func (a *dbAdapter) GetFileByPath(path string) (*db.FileRecord, error) {
	return a.indexDB.GetFileByPath(path)
}

// UpsertFile inserts or updates a file record
func (a *dbAdapter) UpsertFile(record *db.FileRecord) (bool, error) {
	return a.indexDB.UpsertFile(context.Background(), record)
}

// DeleteFile removes a file record
func (a *dbAdapter) DeleteFile(path string) error {
	return a.indexDB.DeleteFile(context.Background(), path)
}

// UpdateFileField updates a single field on a file record
func (a *dbAdapter) UpdateFileField(path string, field string, value interface{}) error {
	return a.indexDB.UpdateFileField(context.Background(), path, field, value)
}

// MoveFileAtomic atomically moves a file record from oldPath to newPath,
// including any matching pin. Cross-DB atomic via the index writer's ATTACH.
func (a *dbAdapter) MoveFileAtomic(oldPath, newPath string, record *db.FileRecord) error {
	return a.indexDB.MoveFileAtomic(context.Background(), oldPath, newPath, record)
}

// ListAllFilePaths returns all file paths in the database (for reconciliation)
func (a *dbAdapter) ListAllFilePaths() ([]string, error) {
	return a.indexDB.ListAllFilePaths()
}

// RenameFilePath updates a single file's path/name and rewrites any matching
// pin in the same atomic transaction.
func (a *dbAdapter) RenameFilePath(oldPath, newPath, newName string) error {
	return a.indexDB.RenameFilePath(context.Background(), oldPath, newPath, newName)
}

// RenameFilePaths updates all paths under oldPath (folder rename) and rewrites
// matching pins in the same atomic transaction.
func (a *dbAdapter) RenameFilePaths(oldPath, newPath string) error {
	return a.indexDB.RenameFilePaths(context.Background(), oldPath, newPath)
}

// DeleteFileWithCascade removes a file (and all related rows including any
// matching pin) in one atomic cross-DB transaction.
func (a *dbAdapter) DeleteFileWithCascade(path string) error {
	return a.indexDB.DeleteFileWithCascade(context.Background(), path)
}

// BatchDeleteFilesWithCascade removes multiple files and all related rows
// (including matching pins) in one atomic cross-DB transaction.
func (a *dbAdapter) BatchDeleteFilesWithCascade(paths []string) error {
	return a.indexDB.BatchDeleteFilesWithCascade(context.Background(), paths)
}

// DeleteFilesWithCascadePrefix removes a folder and all rows under it
// (including matching pins) in one atomic cross-DB transaction.
func (a *dbAdapter) DeleteFilesWithCascadePrefix(pathPrefix string) error {
	return a.indexDB.DeleteFilesWithCascadePrefix(context.Background(), pathPrefix)
}

// GetFilesMissingPreviews returns files that need preview generation
func (a *dbAdapter) GetFilesMissingPreviews(limit int) ([]db.FileWithMime, error) {
	return a.indexDB.GetFilesMissingPreviews(limit)
}

// SqlarStore stores data in the SQLAR table
func (a *dbAdapter) SqlarStore(name string, data []byte, mode int) bool {
	return a.indexDB.SqlarStore(context.Background(), name, data, mode)
}

// SqlarExists checks if a name exists in the SQLAR table
func (a *dbAdapter) SqlarExists(name string) bool {
	return a.indexDB.SqlarExists(name)
}
