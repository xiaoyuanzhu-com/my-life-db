package db

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// GetPreviewSqlarMap returns a map of filename -> previewSqlar for files in a directory.
// Only returns entries where preview_status = 'ready' and preview_sqlar IS NOT NULL.
func (d *DB) GetPreviewSqlarMap(dirPath string) (map[string]string, error) {
	query := `
		SELECT name, preview_sqlar
		FROM files
		WHERE path LIKE ? || '%'
		  AND path NOT LIKE ? || '%/%'
		  AND preview_status = 'ready'
		  AND preview_sqlar IS NOT NULL
	`
	prefix := dirPath
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}

	rows, err := d.conn.Query(query, prefix, prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var name, sqlar string
		if err := rows.Scan(&name, &sqlar); err != nil {
			continue
		}
		result[name] = sqlar
	}
	return result, rows.Err()
}

// GetCreatedAtMap returns a map of name -> created_at (epoch ms) for direct
// children of dirPath. Includes both files and folders. Used by the library
// tree handler to surface "first seen" time as a sortable createdAt field.
func (d *DB) GetCreatedAtMap(dirPath string) (map[string]int64, error) {
	query := `
		SELECT name, created_at
		FROM files
		WHERE path LIKE ? || '%'
		  AND path NOT LIKE ? || '%/%'
	`
	prefix := dirPath
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}

	rows, err := d.conn.Query(query, prefix, prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]int64)
	for rows.Next() {
		var name string
		var createdAt int64
		if err := rows.Scan(&name, &createdAt); err != nil {
			continue
		}
		result[name] = createdAt
	}
	return result, rows.Err()
}

// GetFileByPath retrieves a file record by path
func (d *DB) GetFileByPath(path string) (*FileRecord, error) {
	query := `
		SELECT path, name, is_folder, size, mime_type, hash,
			   modified_at, created_at, last_scanned_at, text_preview, preview_sqlar, preview_status
		FROM files
		WHERE path = ?
	`

	row := d.conn.QueryRow(query, path)

	var f FileRecord
	var isFolder int
	var size sql.NullInt64
	var hash, mimeType, textPreview, previewSqlar, previewStatus sql.NullString
	var lastScannedAt sql.NullInt64

	err := row.Scan(
		&f.Path, &f.Name, &isFolder, &size, &mimeType,
		&hash, &f.ModifiedAt, &f.CreatedAt, &lastScannedAt,
		&textPreview, &previewSqlar, &previewStatus,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	f.IsFolder = isFolder == 1
	f.Size = IntPtr(size)
	f.Hash = StringPtr(hash)
	f.MimeType = StringPtr(mimeType)
	f.TextPreview = StringPtr(textPreview)
	f.PreviewSqlar = StringPtr(previewSqlar)
	f.PreviewStatus = StringPtr(previewStatus)
	f.LastScannedAt = lastScannedAt.Int64

	return &f, nil
}

// UpsertFile inserts or updates a file record
func (d *DB) UpsertFile(ctx context.Context, f *FileRecord) (bool, error) {
	// Check if file exists before upsert to determine if this is a new insert
	var existingPath string
	err := d.conn.QueryRow("SELECT path FROM files WHERE path = ?", f.Path).Scan(&existingPath)
	isNewInsert := err != nil // If error (no rows), it's a new insert

	query := `
		INSERT INTO files (path, name, is_folder, size, mime_type, hash, modified_at, created_at, last_scanned_at, text_preview, preview_sqlar, preview_status)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			name = excluded.name,
			is_folder = excluded.is_folder,
			size = excluded.size,
			mime_type = excluded.mime_type,
			hash = COALESCE(NULLIF(excluded.hash, ''), files.hash),
			modified_at = excluded.modified_at,
			last_scanned_at = excluded.last_scanned_at,
			text_preview = COALESCE(excluded.text_preview, files.text_preview),
			preview_status = COALESCE(excluded.preview_status, files.preview_status)
	`

	isFolder := 0
	if f.IsFolder {
		isFolder = 1
	}

	if err := d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(query,
			f.Path, f.Name, isFolder, f.Size, f.MimeType,
			f.Hash, f.ModifiedAt, f.CreatedAt, f.LastScannedAt,
			f.TextPreview, f.PreviewSqlar, f.PreviewStatus,
		)
		return err
	}); err != nil {
		return false, err
	}
	return isNewInsert, nil
}

// BatchUpsertFiles efficiently upserts multiple file records and returns paths of new inserts
// Uses a single IN-clause query to check existing files, then batch upserts in a transaction
// Processes records in chunks of 500 to avoid parameter limits
func (d *DB) BatchUpsertFiles(ctx context.Context, records []*FileRecord) (newInserts []string, err error) {
	if len(records) == 0 {
		return nil, nil
	}

	const chunkSize = 500

	// Process in chunks
	for i := 0; i < len(records); i += chunkSize {
		end := i + chunkSize
		if end > len(records) {
			end = len(records)
		}
		chunk := records[i:end]

		newInChunk, err := d.batchUpsertChunk(ctx, chunk)
		if err != nil {
			return newInserts, err
		}
		newInserts = append(newInserts, newInChunk...)
	}

	return newInserts, nil
}

// batchUpsertChunk processes a single chunk of file records
func (d *DB) batchUpsertChunk(ctx context.Context, records []*FileRecord) ([]string, error) {
	// 1. Build IN-clause query to check which files already exist
	paths := make([]string, len(records))
	for i, r := range records {
		paths[i] = r.Path
	}

	existingPaths := make(map[string]bool)

	// Build placeholders: ?,?,?
	placeholders := strings.Repeat("?,", len(paths))
	placeholders = placeholders[:len(placeholders)-1]

	query := fmt.Sprintf("SELECT path FROM files WHERE path IN (%s)", placeholders)
	args := make([]interface{}, len(paths))
	for i, p := range paths {
		args[i] = p
	}

	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, err
	}

	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			rows.Close()
			return nil, err
		}
		existingPaths[path] = true
	}
	rows.Close()

	// 2. Batch upsert in a transaction
	var newInserts []string
	err = d.Write(ctx, func(tx *sql.Tx) error {
		stmt, err := tx.Prepare(`
			INSERT INTO files (path, name, is_folder, size, mime_type, hash, modified_at, created_at, last_scanned_at, text_preview, preview_sqlar, preview_status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET
				name = excluded.name,
				is_folder = excluded.is_folder,
				size = excluded.size,
				mime_type = excluded.mime_type,
				hash = COALESCE(NULLIF(excluded.hash, ''), files.hash),
				modified_at = excluded.modified_at,
				last_scanned_at = excluded.last_scanned_at,
				text_preview = COALESCE(excluded.text_preview, files.text_preview),
				preview_status = COALESCE(excluded.preview_status, files.preview_status)
		`)
		if err != nil {
			return err
		}
		defer stmt.Close()

		for _, record := range records {
			isFolder := 0
			if record.IsFolder {
				isFolder = 1
			}

			_, err := stmt.Exec(
				record.Path, record.Name, isFolder, record.Size, record.MimeType,
				record.Hash, record.ModifiedAt, record.CreatedAt, record.LastScannedAt,
				record.TextPreview, record.PreviewSqlar, record.PreviewStatus,
			)
			if err != nil {
				return err
			}

			// Track new inserts
			if !existingPaths[record.Path] {
				newInserts = append(newInserts, record.Path)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	return newInserts, nil
}

// DeleteFile removes a file record
func (d *DB) DeleteFile(ctx context.Context, path string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec("DELETE FROM files WHERE path = ?", path)
		return err
	})
}

// Cursor represents a pagination cursor
type Cursor struct {
	CreatedAt int64
	Path      string
}

// CreateCursor creates a cursor string from a file record
// Format: {epochMs}:{path} (e.g., "1738424226000:inbox/file.md")
func CreateCursor(f *FileRecord) string {
	return strconv.FormatInt(f.CreatedAt, 10) + ":" + f.Path
}

// ParseCursor parses a cursor string
// New format: {epochMs}:{path} (e.g., "1738424226000:inbox/file.md")
// Legacy format: {RFC3339}:{path} (e.g., "2026-02-01T15:37:06Z:inbox/file.md")
func ParseCursor(cursor string) *Cursor {
	// New format: {epochMs}:{path}
	idx := strings.Index(cursor, ":")
	if idx == -1 {
		return nil
	}
	ts, err := strconv.ParseInt(cursor[:idx], 10, 64)
	if err != nil {
		// Try legacy RFC3339 format for backwards compatibility
		if zIdx := strings.Index(cursor, "Z:"); zIdx != -1 {
			legacyTs, err := time.Parse(time.RFC3339, cursor[:zIdx+1])
			if err == nil {
				return &Cursor{CreatedAt: legacyTs.UnixMilli(), Path: cursor[zIdx+2:]}
			}
		}
		return nil
	}
	return &Cursor{CreatedAt: ts, Path: cursor[idx+1:]}
}

// FileListResult represents a paginated list of files
type FileListResult struct {
	Items   []FileRecord
	HasMore struct {
		Older bool
		Newer bool
	}
}

// ListTopLevelFilesNewest lists top-level files in a directory, newest first
func (d *DB) ListTopLevelFilesNewest(pathPrefix string, limit int) (*FileListResult, error) {
	query := `
		SELECT path, name, is_folder, size, mime_type, hash,
			   modified_at, created_at, last_scanned_at, text_preview, preview_sqlar, preview_status
		FROM files
		WHERE path LIKE ? || '%'
		  AND path NOT LIKE ? || '%/%'
		ORDER BY created_at DESC, path DESC
		LIMIT ?
	`

	rows, err := d.conn.Query(query, pathPrefix, pathPrefix, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := &FileListResult{}
	for rows.Next() {
		var f FileRecord
		var isFolder int
		var size sql.NullInt64
		var hash, mimeType, textPreview, previewSqlar, previewStatus sql.NullString
		var lastScannedAt sql.NullInt64

		err := rows.Scan(
			&f.Path, &f.Name, &isFolder, &size, &mimeType,
			&hash, &f.ModifiedAt, &f.CreatedAt, &lastScannedAt,
			&textPreview, &previewSqlar, &previewStatus,
		)
		if err != nil {
			return nil, err
		}

		f.IsFolder = isFolder == 1
		f.Size = IntPtr(size)
		f.Hash = StringPtr(hash)
		f.MimeType = StringPtr(mimeType)
		f.TextPreview = StringPtr(textPreview)
		f.PreviewSqlar = StringPtr(previewSqlar)
		f.PreviewStatus = StringPtr(previewStatus)
		f.LastScannedAt = lastScannedAt.Int64

		result.Items = append(result.Items, f)
	}

	// Check if there are more older items
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		result.HasMore.Older = true
	}

	return result, nil
}

// ListTopLevelFilesBefore lists files older than the cursor
func (d *DB) ListTopLevelFilesBefore(pathPrefix string, cursor *Cursor, limit int) (*FileListResult, error) {
	query := `
		SELECT path, name, is_folder, size, mime_type, hash,
			   modified_at, created_at, last_scanned_at, text_preview, preview_sqlar, preview_status
		FROM files
		WHERE path LIKE ? || '%'
		  AND path NOT LIKE ? || '%/%'
		  AND (created_at < ? OR (created_at = ? AND path < ?))
		ORDER BY created_at DESC, path DESC
		LIMIT ?
	`

	rows, err := d.conn.Query(query, pathPrefix, pathPrefix, cursor.CreatedAt, cursor.CreatedAt, cursor.Path, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := &FileListResult{}
	result.HasMore.Newer = true // There's at least the cursor item

	for rows.Next() {
		var f FileRecord
		var isFolder int
		var size sql.NullInt64
		var hash, mimeType, textPreview, previewSqlar, previewStatus sql.NullString
		var lastScannedAt sql.NullInt64

		err := rows.Scan(
			&f.Path, &f.Name, &isFolder, &size, &mimeType,
			&hash, &f.ModifiedAt, &f.CreatedAt, &lastScannedAt,
			&textPreview, &previewSqlar, &previewStatus,
		)
		if err != nil {
			return nil, err
		}

		f.IsFolder = isFolder == 1
		f.Size = IntPtr(size)
		f.Hash = StringPtr(hash)
		f.MimeType = StringPtr(mimeType)
		f.TextPreview = StringPtr(textPreview)
		f.PreviewSqlar = StringPtr(previewSqlar)
		f.PreviewStatus = StringPtr(previewStatus)
		f.LastScannedAt = lastScannedAt.Int64

		result.Items = append(result.Items, f)
	}

	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		result.HasMore.Older = true
	}

	return result, nil
}

// ListTopLevelFilesAfter lists files newer than the cursor
func (d *DB) ListTopLevelFilesAfter(pathPrefix string, cursor *Cursor, limit int) (*FileListResult, error) {
	query := `
		SELECT path, name, is_folder, size, mime_type, hash,
			   modified_at, created_at, last_scanned_at, text_preview, preview_sqlar, preview_status
		FROM files
		WHERE path LIKE ? || '%'
		  AND path NOT LIKE ? || '%/%'
		  AND (created_at > ? OR (created_at = ? AND path > ?))
		ORDER BY created_at ASC, path ASC
		LIMIT ?
	`

	rows, err := d.conn.Query(query, pathPrefix, pathPrefix, cursor.CreatedAt, cursor.CreatedAt, cursor.Path, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := &FileListResult{}
	result.HasMore.Older = true // There's at least the cursor item

	for rows.Next() {
		var f FileRecord
		var isFolder int
		var size sql.NullInt64
		var hash, mimeType, textPreview, previewSqlar, previewStatus sql.NullString
		var lastScannedAt sql.NullInt64

		err := rows.Scan(
			&f.Path, &f.Name, &isFolder, &size, &mimeType,
			&hash, &f.ModifiedAt, &f.CreatedAt, &lastScannedAt,
			&textPreview, &previewSqlar, &previewStatus,
		)
		if err != nil {
			return nil, err
		}

		f.IsFolder = isFolder == 1
		f.Size = IntPtr(size)
		f.Hash = StringPtr(hash)
		f.MimeType = StringPtr(mimeType)
		f.TextPreview = StringPtr(textPreview)
		f.PreviewSqlar = StringPtr(previewSqlar)
		f.PreviewStatus = StringPtr(previewStatus)
		f.LastScannedAt = lastScannedAt.Int64

		result.Items = append(result.Items, f)
	}

	// Reverse to get newest-first order
	for i, j := 0, len(result.Items)-1; i < j; i, j = i+1, j-1 {
		result.Items[i], result.Items[j] = result.Items[j], result.Items[i]
	}

	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		result.HasMore.Newer = true
	}

	return result, nil
}

// FileListAroundResult represents a paginated list with target index
type FileListAroundResult struct {
	Items       []FileRecord
	TargetIndex int
	HasMore     struct {
		Older bool
		Newer bool
	}
}

// ListTopLevelFilesAround loads items centered around a cursor
// Used for pin navigation - returns a page containing the pinned item
func (d *DB) ListTopLevelFilesAround(pathPrefix string, cursor *Cursor, limit int) (*FileListAroundResult, error) {
	halfLimit := limit / 2

	// Load items BEFORE cursor (older, including cursor item)
	beforeQuery := `
		SELECT path, name, is_folder, size, mime_type, hash,
			   modified_at, created_at, last_scanned_at, text_preview, preview_sqlar, preview_status
		FROM files
		WHERE path LIKE ? || '%'
		  AND path NOT LIKE ? || '%/%'
		  AND (created_at < ? OR (created_at = ? AND path <= ?))
		ORDER BY created_at DESC, path DESC
		LIMIT ?
	`

	beforeRows, err := d.conn.Query(beforeQuery, pathPrefix, pathPrefix, cursor.CreatedAt, cursor.CreatedAt, cursor.Path, halfLimit+1)
	if err != nil {
		return nil, err
	}
	defer beforeRows.Close()

	var beforeItems []FileRecord
	for beforeRows.Next() {
		var f FileRecord
		var isFolder int
		var size sql.NullInt64
		var hash, mimeType, textPreview, previewSqlar, previewStatus sql.NullString
		var lastScannedAt sql.NullInt64

		err := beforeRows.Scan(
			&f.Path, &f.Name, &isFolder, &size, &mimeType,
			&hash, &f.ModifiedAt, &f.CreatedAt, &lastScannedAt,
			&textPreview, &previewSqlar, &previewStatus,
		)
		if err != nil {
			return nil, err
		}

		f.IsFolder = isFolder == 1
		f.Size = IntPtr(size)
		f.Hash = StringPtr(hash)
		f.MimeType = StringPtr(mimeType)
		f.TextPreview = StringPtr(textPreview)
		f.PreviewSqlar = StringPtr(previewSqlar)
		f.PreviewStatus = StringPtr(previewStatus)
		f.LastScannedAt = lastScannedAt.Int64

		beforeItems = append(beforeItems, f)
	}

	// Load items AFTER cursor (newer, excluding cursor item)
	afterQuery := `
		SELECT path, name, is_folder, size, mime_type, hash,
			   modified_at, created_at, last_scanned_at, text_preview, preview_sqlar, preview_status
		FROM files
		WHERE path LIKE ? || '%'
		  AND path NOT LIKE ? || '%/%'
		  AND (created_at > ? OR (created_at = ? AND path > ?))
		ORDER BY created_at ASC, path ASC
		LIMIT ?
	`

	afterRows, err := d.conn.Query(afterQuery, pathPrefix, pathPrefix, cursor.CreatedAt, cursor.CreatedAt, cursor.Path, halfLimit+1)
	if err != nil {
		return nil, err
	}
	defer afterRows.Close()

	var afterItems []FileRecord
	for afterRows.Next() {
		var f FileRecord
		var isFolder int
		var size sql.NullInt64
		var hash, mimeType, textPreview, previewSqlar, previewStatus sql.NullString
		var lastScannedAt sql.NullInt64

		err := afterRows.Scan(
			&f.Path, &f.Name, &isFolder, &size, &mimeType,
			&hash, &f.ModifiedAt, &f.CreatedAt, &lastScannedAt,
			&textPreview, &previewSqlar, &previewStatus,
		)
		if err != nil {
			return nil, err
		}

		f.IsFolder = isFolder == 1
		f.Size = IntPtr(size)
		f.Hash = StringPtr(hash)
		f.MimeType = StringPtr(mimeType)
		f.TextPreview = StringPtr(textPreview)
		f.PreviewSqlar = StringPtr(previewSqlar)
		f.PreviewStatus = StringPtr(previewStatus)
		f.LastScannedAt = lastScannedAt.Int64

		afterItems = append(afterItems, f)
	}

	// Determine hasMore
	hasOlder := len(beforeItems) > halfLimit
	hasNewer := len(afterItems) > halfLimit

	// Trim to limits
	if hasOlder {
		beforeItems = beforeItems[:halfLimit]
	}
	if hasNewer {
		afterItems = afterItems[:halfLimit]
	}

	// Reverse afterItems to get DESC order (newest first)
	for i, j := 0, len(afterItems)-1; i < j; i, j = i+1, j-1 {
		afterItems[i], afterItems[j] = afterItems[j], afterItems[i]
	}

	// Combine: newer items (now in DESC) + older items (already in DESC)
	// The target item is at the junction - first item in beforeItems
	result := &FileListAroundResult{
		Items:       append(afterItems, beforeItems...),
		TargetIndex: len(afterItems),
	}
	result.HasMore.Older = hasOlder
	result.HasMore.Newer = hasNewer

	return result, nil
}

// GeneratePathHash creates a hash from a file path for stable IDs
func GeneratePathHash(path string) string {
	h := sha256.Sum256([]byte(path))
	return hex.EncodeToString(h[:8]) // First 16 hex chars (8 bytes)
}

// CountFilesInPath counts files in a path prefix
func (d *DB) CountFilesInPath(pathPrefix string) (int64, error) {
	var count int64
	err := d.conn.QueryRow(`
		SELECT COUNT(*) FROM files WHERE path LIKE ? || '%'
	`, pathPrefix).Scan(&count)
	return count, err
}

// GetFileStats returns statistics about files
func (d *DB) GetFileStats() (map[string]interface{}, error) {
	stats := make(map[string]interface{})

	// Total files
	var totalFiles int64
	err := d.conn.QueryRow("SELECT COUNT(*) FROM files WHERE is_folder = 0").Scan(&totalFiles)
	if err != nil {
		return nil, err
	}
	stats["totalFiles"] = totalFiles

	// Total folders
	var totalFolders int64
	err = d.conn.QueryRow("SELECT COUNT(*) FROM files WHERE is_folder = 1").Scan(&totalFolders)
	if err != nil {
		return nil, err
	}
	stats["totalFolders"] = totalFolders

	// Files by type (top 10)
	rows, err := d.conn.Query(`
		SELECT mime_type, COUNT(*) as count
		FROM files
		WHERE mime_type IS NOT NULL AND is_folder = 0
		GROUP BY mime_type
		ORDER BY count DESC
		LIMIT 10
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var byType []map[string]interface{}
	for rows.Next() {
		var mimeType string
		var count int64
		if err := rows.Scan(&mimeType, &count); err != nil {
			return nil, err
		}
		byType = append(byType, map[string]interface{}{
			"mimeType": mimeType,
			"count":    count,
		})
	}
	stats["byType"] = byType

	// Inbox files
	var inboxFiles int64
	err = d.conn.QueryRow("SELECT COUNT(*) FROM files WHERE path LIKE 'inbox/%' AND is_folder = 0").Scan(&inboxFiles)
	if err != nil {
		return nil, err
	}
	stats["inboxFiles"] = inboxFiles

	return stats, nil
}

// FileWithDigests represents a file with its digests
type FileWithDigests struct {
	FileRecord
	Digests  []Digest `json:"digests"`
	IsPinned bool     `json:"isPinned"`
}

// GetFileWithDigests retrieves a file with all its digests
func (d *DB) GetFileWithDigests(path string) (*FileWithDigests, error) {
	file, err := d.GetFileByPath(path)
	if err != nil || file == nil {
		return nil, err
	}

	digests, err := GetDigestsForFile(path)
	if err != nil {
		return nil, err
	}

	isPinned, err := IsPinned(path)
	if err != nil {
		return nil, err
	}

	return &FileWithDigests{
		FileRecord: *file,
		Digests:    digests,
		IsPinned:   isPinned,
	}, nil
}

// RenameFilePath updates a single file's path and name, including all related tables.
// Updates: files, digests, pins, files_fts.
func (d *DB) RenameFilePath(ctx context.Context, oldPath, newPath, newName string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		// Update files
		if _, err := tx.Exec(`UPDATE files SET path = ?, name = ? WHERE path = ?`, newPath, newName, oldPath); err != nil {
			return fmt.Errorf("failed to update files: %w", err)
		}

		// Update digests
		if _, err := tx.Exec(`UPDATE digests SET file_path = ? WHERE file_path = ?`, newPath, oldPath); err != nil {
			return fmt.Errorf("failed to update digests: %w", err)
		}

		// Update pins
		if _, err := tx.Exec(`UPDATE pins SET file_path = ? WHERE file_path = ?`, newPath, oldPath); err != nil {
			return fmt.Errorf("failed to update pins: %w", err)
		}

		// Update FTS5 search index
		if _, err := tx.Exec(`UPDATE files_fts SET file_path = ? WHERE file_path = ?`, newPath, oldPath); err != nil {
			return fmt.Errorf("failed to update files_fts: %w", err)
		}

		return nil
	})
}

// RenameFilePaths updates all paths that start with oldPath prefix (for folder renames).
// Updates all related tables: files, digests, pins, files_fts.
func (d *DB) RenameFilePaths(ctx context.Context, oldPath, newPath string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		// Update files table - all files and subfolders
		if _, err := tx.Exec(`
			UPDATE files
			SET path = ? || substr(path, ?) ,
				name = CASE
					WHEN path = ? THEN ?
					ELSE name
				END
			WHERE path = ? OR path LIKE ? || '/%'
		`, newPath, len(oldPath)+1, oldPath, filepath.Base(newPath), oldPath, oldPath); err != nil {
			return fmt.Errorf("failed to update files: %w", err)
		}

		// Update digests
		if _, err := tx.Exec(`
			UPDATE digests
			SET file_path = ? || substr(file_path, ?)
			WHERE file_path = ? OR file_path LIKE ? || '/%'
		`, newPath, len(oldPath)+1, oldPath, oldPath); err != nil {
			return fmt.Errorf("failed to update digests: %w", err)
		}

		// Update pins
		if _, err := tx.Exec(`
			UPDATE pins
			SET file_path = ? || substr(file_path, ?)
			WHERE file_path = ? OR file_path LIKE ? || '/%'
		`, newPath, len(oldPath)+1, oldPath, oldPath); err != nil {
			return fmt.Errorf("failed to update pins: %w", err)
		}

		// Update FTS5 search index
		if _, err := tx.Exec(`
			UPDATE files_fts
			SET file_path = ? || substr(file_path, ?)
			WHERE file_path = ? OR file_path LIKE ? || '/%'
		`, newPath, len(oldPath)+1, oldPath, oldPath); err != nil {
			return fmt.Errorf("failed to update files_fts: %w", err)
		}

		return nil
	})
}

// UpdateFileField updates a single field on a file record
func (d *DB) UpdateFileField(ctx context.Context, path string, field string, value interface{}) error {
	// Whitelist of allowed fields
	allowedFields := map[string]bool{
		"text_preview":   true,
		"preview_sqlar":  true,
		"preview_status": true,
		"hash":           true,
		"size":           true,
		"modified_at":    true,
	}

	if !allowedFields[field] {
		return fmt.Errorf("field %s is not allowed to be updated", field)
	}

	query := fmt.Sprintf("UPDATE files SET %s = ? WHERE path = ?", field)
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(query, value, path)
		return err
	})
}

// MoveFileAtomic atomically moves a file record from oldPath to newPath.
// This is used when detecting external file moves via fsnotify.
// It updates the file record and ALL related tables in a single transaction:
// files, digests, pins, files_fts.
func (d *DB) MoveFileAtomic(ctx context.Context, oldPath, newPath string, newRecord *FileRecord) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		// 1. Insert/update new path with smart COALESCE handling
		isFolder := 0
		if newRecord.IsFolder {
			isFolder = 1
		}

		if _, err := tx.Exec(`
			INSERT INTO files (path, name, is_folder, size, mime_type, hash, modified_at, created_at, last_scanned_at, text_preview, preview_sqlar, preview_status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET
				name = excluded.name,
				is_folder = excluded.is_folder,
				size = excluded.size,
				mime_type = excluded.mime_type,
				hash = COALESCE(NULLIF(excluded.hash, ''), files.hash),
				modified_at = excluded.modified_at,
				last_scanned_at = excluded.last_scanned_at,
				text_preview = COALESCE(excluded.text_preview, files.text_preview),
				preview_status = COALESCE(excluded.preview_status, files.preview_status)
		`, newRecord.Path, newRecord.Name, isFolder, newRecord.Size, newRecord.MimeType,
			newRecord.Hash, newRecord.ModifiedAt, newRecord.CreatedAt, newRecord.LastScannedAt,
			newRecord.TextPreview, newRecord.PreviewSqlar, newRecord.PreviewStatus); err != nil {
			return fmt.Errorf("failed to insert new path: %w", err)
		}

		// 2. Delete old path (if different from new path)
		if oldPath != newPath {
			if _, err := tx.Exec(`DELETE FROM files WHERE path = ?`, oldPath); err != nil {
				return fmt.Errorf("failed to delete old path: %w", err)
			}
		}

		// 3. Update related tables: digests
		if _, err := tx.Exec(`UPDATE digests SET file_path = ? WHERE file_path = ?`, newPath, oldPath); err != nil {
			return fmt.Errorf("failed to update digests: %w", err)
		}

		// 4. Update related tables: pins
		if _, err := tx.Exec(`UPDATE pins SET file_path = ? WHERE file_path = ?`, newPath, oldPath); err != nil {
			return fmt.Errorf("failed to update pins: %w", err)
		}

		// 5. Update related tables: files_fts
		if _, err := tx.Exec(`UPDATE files_fts SET file_path = ? WHERE file_path = ?`, newPath, oldPath); err != nil {
			return fmt.Errorf("failed to update files_fts: %w", err)
		}

		return nil
	})
}

// FileWithMime holds a file path and its MIME type.
type FileWithMime struct {
	Path     string
	MimeType string
}

// GetFilesMissingPreviews returns files with preview_status = 'pending'.
// Results are limited to avoid overwhelming the preview queue.
func (d *DB) GetFilesMissingPreviews(limit int) ([]FileWithMime, error) {
	rows, err := d.conn.Query(`
		SELECT path, mime_type FROM files
		WHERE preview_status = 'pending'
		LIMIT ?
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []FileWithMime
	for rows.Next() {
		var f FileWithMime
		if err := rows.Scan(&f.Path, &f.MimeType); err != nil {
			return nil, err
		}
		files = append(files, f)
	}

	return files, rows.Err()
}

// ListAllFilePaths returns all file paths in the database (for reconciliation).
// The caller is responsible for closing the returned rows.
func (d *DB) ListAllFilePaths() ([]string, error) {
	rows, err := d.conn.Query("SELECT path FROM files WHERE is_folder = 0")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var paths []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}

	return paths, rows.Err()
}

// DeleteFileWithCascade removes a file record and all related records in a single transaction.
// This includes: digests, pins, files_fts.
// Used during reconciliation and file deletion to clean up all related data.
func (d *DB) DeleteFileWithCascade(ctx context.Context, path string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		// Delete search index documents first
		if _, err := tx.Exec("DELETE FROM files_fts WHERE file_path = ?", path); err != nil {
			return fmt.Errorf("failed to delete files_fts: %w", err)
		}

		// Delete digests
		if _, err := tx.Exec("DELETE FROM digests WHERE file_path = ?", path); err != nil {
			return fmt.Errorf("failed to delete digests: %w", err)
		}

		// Delete pins
		if _, err := tx.Exec("DELETE FROM pins WHERE file_path = ?", path); err != nil {
			return fmt.Errorf("failed to delete pins: %w", err)
		}

		// Delete file record
		if _, err := tx.Exec("DELETE FROM files WHERE path = ?", path); err != nil {
			return fmt.Errorf("failed to delete file: %w", err)
		}

		return nil
	})
}

// BatchDeleteFilesWithCascade removes multiple file records and all related rows
// (files_fts, digests, pins) in a single transaction. Used by reconciliation to
// avoid one-transaction-per-orphan when there are thousands of records to remove.
// Caller is responsible for chunking to stay under SQLite's parameter limit
// (SQLITE_MAX_VARIABLE_NUMBER, typically 999 on older builds, 32766 on newer).
func (d *DB) BatchDeleteFilesWithCascade(ctx context.Context, paths []string) error {
	if len(paths) == 0 {
		return nil
	}

	placeholders := strings.Repeat("?,", len(paths))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]interface{}, len(paths))
	for i, p := range paths {
		args[i] = p
	}

	return d.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM files_fts WHERE file_path IN ("+placeholders+")", args...); err != nil {
			return fmt.Errorf("failed to delete files_fts: %w", err)
		}
		if _, err := tx.Exec("DELETE FROM digests WHERE file_path IN ("+placeholders+")", args...); err != nil {
			return fmt.Errorf("failed to delete digests: %w", err)
		}
		if _, err := tx.Exec("DELETE FROM pins WHERE file_path IN ("+placeholders+")", args...); err != nil {
			return fmt.Errorf("failed to delete pins: %w", err)
		}
		if _, err := tx.Exec("DELETE FROM files WHERE path IN ("+placeholders+")", args...); err != nil {
			return fmt.Errorf("failed to delete files: %w", err)
		}
		return nil
	})
}

// DeleteFilesWithCascadePrefix removes a folder and all files/records under it in a single transaction.
// Cleans up: files, digests, pins, files_fts.
// Used for recursive folder deletion.
func (d *DB) DeleteFilesWithCascadePrefix(ctx context.Context, pathPrefix string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		// Delete search index documents
		if _, err := tx.Exec("DELETE FROM files_fts WHERE file_path = ? OR file_path LIKE ? || '/%'", pathPrefix, pathPrefix); err != nil {
			return fmt.Errorf("failed to delete files_fts: %w", err)
		}

		// Delete digests
		if _, err := tx.Exec("DELETE FROM digests WHERE file_path = ? OR file_path LIKE ? || '/%'", pathPrefix, pathPrefix); err != nil {
			return fmt.Errorf("failed to delete digests: %w", err)
		}

		// Delete pins
		if _, err := tx.Exec("DELETE FROM pins WHERE file_path = ? OR file_path LIKE ? || '/%'", pathPrefix, pathPrefix); err != nil {
			return fmt.Errorf("failed to delete pins: %w", err)
		}

		// Delete file records
		if _, err := tx.Exec("DELETE FROM files WHERE path = ? OR path LIKE ? || '/%'", pathPrefix, pathPrefix); err != nil {
			return fmt.Errorf("failed to delete files: %w", err)
		}

		return nil
	})
}
