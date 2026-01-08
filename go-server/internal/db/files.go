package db

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
)

// GetFileByPath retrieves a file record by path
func GetFileByPath(path string) (*FileRecord, error) {
	query := `
		SELECT path, name, is_folder, size, mime_type, hash,
			   modified_at, created_at, last_scanned_at, text_preview, screenshot_sqlar
		FROM files
		WHERE path = ?
	`

	row := GetDB().QueryRow(query, path)

	var f FileRecord
	var isFolder int
	var size, hash, mimeType, textPreview, screenshotSqlar sql.NullString
	var lastScannedAt sql.NullString

	err := row.Scan(
		&f.Path, &f.Name, &isFolder, &size, &mimeType,
		&hash, &f.ModifiedAt, &f.CreatedAt, &lastScannedAt,
		&textPreview, &screenshotSqlar,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	f.IsFolder = isFolder == 1
	if size.Valid {
		s, _ := size.Int64, nil
		sizeInt := s
		f.Size = &sizeInt
	}
	f.Hash = StringPtr(sql.NullString{String: hash.String, Valid: hash.Valid})
	f.MimeType = StringPtr(sql.NullString{String: mimeType.String, Valid: mimeType.Valid})
	f.TextPreview = StringPtr(sql.NullString{String: textPreview.String, Valid: textPreview.Valid})
	f.ScreenshotSqlar = StringPtr(sql.NullString{String: screenshotSqlar.String, Valid: screenshotSqlar.Valid})
	f.LastScannedAt = lastScannedAt.String

	return &f, nil
}

// UpsertFile inserts or updates a file record
func UpsertFile(f *FileRecord) error {
	query := `
		INSERT INTO files (path, name, is_folder, size, mime_type, hash, modified_at, created_at, last_scanned_at, text_preview, screenshot_sqlar)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			name = excluded.name,
			is_folder = excluded.is_folder,
			size = excluded.size,
			mime_type = excluded.mime_type,
			hash = excluded.hash,
			modified_at = excluded.modified_at,
			last_scanned_at = excluded.last_scanned_at,
			text_preview = excluded.text_preview,
			screenshot_sqlar = excluded.screenshot_sqlar
	`

	isFolder := 0
	if f.IsFolder {
		isFolder = 1
	}

	_, err := GetDB().Exec(query,
		f.Path, f.Name, isFolder, f.Size, f.MimeType,
		f.Hash, f.ModifiedAt, f.CreatedAt, f.LastScannedAt,
		f.TextPreview, f.ScreenshotSqlar,
	)
	return err
}

// DeleteFile removes a file record
func DeleteFile(path string) error {
	_, err := GetDB().Exec("DELETE FROM files WHERE path = ?", path)
	return err
}

// Cursor represents a pagination cursor
type Cursor struct {
	ModifiedAt string
	Path       string
}

// CreateCursor creates a cursor string from a file record
func CreateCursor(f *FileRecord) string {
	return f.ModifiedAt + "|" + f.Path
}

// ParseCursor parses a cursor string
func ParseCursor(cursor string) *Cursor {
	parts := strings.SplitN(cursor, "|", 2)
	if len(parts) != 2 {
		return nil
	}
	return &Cursor{
		ModifiedAt: parts[0],
		Path:       parts[1],
	}
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
func ListTopLevelFilesNewest(pathPrefix string, limit int) (*FileListResult, error) {
	query := `
		SELECT path, name, is_folder, size, mime_type, hash,
			   modified_at, created_at, last_scanned_at, text_preview, screenshot_sqlar
		FROM files
		WHERE path LIKE ? || '%'
		  AND path NOT LIKE ? || '%/%'
		ORDER BY modified_at DESC, path DESC
		LIMIT ?
	`

	rows, err := GetDB().Query(query, pathPrefix, pathPrefix, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := &FileListResult{}
	for rows.Next() {
		var f FileRecord
		var isFolder int
		var size sql.NullInt64
		var hash, mimeType, textPreview, screenshotSqlar, lastScannedAt sql.NullString

		err := rows.Scan(
			&f.Path, &f.Name, &isFolder, &size, &mimeType,
			&hash, &f.ModifiedAt, &f.CreatedAt, &lastScannedAt,
			&textPreview, &screenshotSqlar,
		)
		if err != nil {
			return nil, err
		}

		f.IsFolder = isFolder == 1
		f.Size = IntPtr(size)
		f.Hash = StringPtr(hash)
		f.MimeType = StringPtr(mimeType)
		f.TextPreview = StringPtr(textPreview)
		f.ScreenshotSqlar = StringPtr(screenshotSqlar)
		f.LastScannedAt = lastScannedAt.String

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
func ListTopLevelFilesBefore(pathPrefix string, cursor *Cursor, limit int) (*FileListResult, error) {
	query := `
		SELECT path, name, is_folder, size, mime_type, hash,
			   modified_at, created_at, last_scanned_at, text_preview, screenshot_sqlar
		FROM files
		WHERE path LIKE ? || '%'
		  AND path NOT LIKE ? || '%/%'
		  AND (modified_at < ? OR (modified_at = ? AND path < ?))
		ORDER BY modified_at DESC, path DESC
		LIMIT ?
	`

	rows, err := GetDB().Query(query, pathPrefix, pathPrefix, cursor.ModifiedAt, cursor.ModifiedAt, cursor.Path, limit+1)
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
		var hash, mimeType, textPreview, screenshotSqlar, lastScannedAt sql.NullString

		err := rows.Scan(
			&f.Path, &f.Name, &isFolder, &size, &mimeType,
			&hash, &f.ModifiedAt, &f.CreatedAt, &lastScannedAt,
			&textPreview, &screenshotSqlar,
		)
		if err != nil {
			return nil, err
		}

		f.IsFolder = isFolder == 1
		f.Size = IntPtr(size)
		f.Hash = StringPtr(hash)
		f.MimeType = StringPtr(mimeType)
		f.TextPreview = StringPtr(textPreview)
		f.ScreenshotSqlar = StringPtr(screenshotSqlar)
		f.LastScannedAt = lastScannedAt.String

		result.Items = append(result.Items, f)
	}

	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		result.HasMore.Older = true
	}

	return result, nil
}

// ListTopLevelFilesAfter lists files newer than the cursor
func ListTopLevelFilesAfter(pathPrefix string, cursor *Cursor, limit int) (*FileListResult, error) {
	query := `
		SELECT path, name, is_folder, size, mime_type, hash,
			   modified_at, created_at, last_scanned_at, text_preview, screenshot_sqlar
		FROM files
		WHERE path LIKE ? || '%'
		  AND path NOT LIKE ? || '%/%'
		  AND (modified_at > ? OR (modified_at = ? AND path > ?))
		ORDER BY modified_at ASC, path ASC
		LIMIT ?
	`

	rows, err := GetDB().Query(query, pathPrefix, pathPrefix, cursor.ModifiedAt, cursor.ModifiedAt, cursor.Path, limit+1)
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
		var hash, mimeType, textPreview, screenshotSqlar, lastScannedAt sql.NullString

		err := rows.Scan(
			&f.Path, &f.Name, &isFolder, &size, &mimeType,
			&hash, &f.ModifiedAt, &f.CreatedAt, &lastScannedAt,
			&textPreview, &screenshotSqlar,
		)
		if err != nil {
			return nil, err
		}

		f.IsFolder = isFolder == 1
		f.Size = IntPtr(size)
		f.Hash = StringPtr(hash)
		f.MimeType = StringPtr(mimeType)
		f.TextPreview = StringPtr(textPreview)
		f.ScreenshotSqlar = StringPtr(screenshotSqlar)
		f.LastScannedAt = lastScannedAt.String

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

// GeneratePathHash creates a hash from a file path for stable IDs
func GeneratePathHash(path string) string {
	h := sha256.Sum256([]byte(path))
	return hex.EncodeToString(h[:8]) // First 16 hex chars (8 bytes)
}

// CountFilesInPath counts files in a path prefix
func CountFilesInPath(pathPrefix string) (int64, error) {
	var count int64
	err := GetDB().QueryRow(`
		SELECT COUNT(*) FROM files WHERE path LIKE ? || '%'
	`, pathPrefix).Scan(&count)
	return count, err
}

// GetFileStats returns statistics about files
func GetFileStats() (map[string]interface{}, error) {
	stats := make(map[string]interface{})

	// Total files
	var totalFiles int64
	err := GetDB().QueryRow("SELECT COUNT(*) FROM files WHERE is_folder = 0").Scan(&totalFiles)
	if err != nil {
		return nil, err
	}
	stats["totalFiles"] = totalFiles

	// Total folders
	var totalFolders int64
	err = GetDB().QueryRow("SELECT COUNT(*) FROM files WHERE is_folder = 1").Scan(&totalFolders)
	if err != nil {
		return nil, err
	}
	stats["totalFolders"] = totalFolders

	// Files by type (top 10)
	rows, err := GetDB().Query(`
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
	err = GetDB().QueryRow("SELECT COUNT(*) FROM files WHERE path LIKE 'inbox/%' AND is_folder = 0").Scan(&inboxFiles)
	if err != nil {
		return nil, err
	}
	stats["inboxFiles"] = inboxFiles

	return stats, nil
}

// FileWithDigests represents a file with its digests
type FileWithDigests struct {
	FileRecord
	Digests []Digest `json:"digests"`
	IsPinned bool    `json:"isPinned"`
}

// GetFileWithDigests retrieves a file with all its digests
func GetFileWithDigests(path string) (*FileWithDigests, error) {
	file, err := GetFileByPath(path)
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

// UpdateFileField updates a single field on a file record
func UpdateFileField(path string, field string, value interface{}) error {
	// Whitelist of allowed fields
	allowedFields := map[string]bool{
		"text_preview":     true,
		"screenshot_sqlar": true,
		"hash":             true,
		"size":             true,
		"modified_at":      true,
	}

	if !allowedFields[field] {
		return fmt.Errorf("field %s is not allowed to be updated", field)
	}

	query := fmt.Sprintf("UPDATE files SET %s = ? WHERE path = ?", field)
	_, err := GetDB().Exec(query, value, path)
	return err
}
