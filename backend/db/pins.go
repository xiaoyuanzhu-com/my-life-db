package db

import (
	"context"
	"database/sql"
	"strings"

	"github.com/google/uuid"
)

// IsPinned checks if a file is pinned
func (d *DB) IsPinned(path string) (bool, error) {
	var count int
	err := d.conn.QueryRow("SELECT COUNT(*) FROM pins WHERE file_path = ?", path).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// GetPinnedSet returns the subset of the given paths that are pinned, as a
// set keyed by path. Single query — replaces N IsPinned() calls.
func (d *DB) GetPinnedSet(paths []string) (map[string]bool, error) {
	result := make(map[string]bool, len(paths))
	if len(paths) == 0 {
		return result, nil
	}

	placeholders := make([]string, len(paths))
	args := make([]any, len(paths))
	for i, p := range paths {
		placeholders[i] = "?"
		args[i] = p
	}

	query := `SELECT file_path FROM pins WHERE file_path IN (` + strings.Join(placeholders, ",") + `)`
	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		result[p] = true
	}
	return result, rows.Err()
}

// AddPin pins a file
func (d *DB) AddPin(ctx context.Context, path string) error {
	// Generate a unique ID for the pin
	id := uuid.New().String()
	now := NowMs()
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`
			INSERT INTO pins (id, file_path, pinned_at, created_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(file_path) DO NOTHING
		`, id, path, now, now)
		return err
	})
}

// RemovePin unpins a file
func (d *DB) RemovePin(ctx context.Context, path string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec("DELETE FROM pins WHERE file_path = ?", path)
		return err
	})
}

// GetAllPins retrieves all pinned files
func (d *DB) GetAllPins() ([]Pin, error) {
	rows, err := d.conn.Query(`
		SELECT file_path, pinned_at FROM pins ORDER BY pinned_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pins []Pin
	for rows.Next() {
		var p Pin
		if err := rows.Scan(&p.Path, &p.CreatedAt); err != nil {
			return nil, err
		}
		pins = append(pins, p)
	}

	return pins, nil
}

// GetPinnedFiles retrieves all pinned files as FileRecords.
// Pins live in the app DB; files live in the index DB ATTACHed read-only as
// 'idx' on every app-DB connection (see registerAppDriver). The JOIN below
// requires that ATTACH to be present.
func (d *DB) GetPinnedFiles() ([]FileRecord, error) {
	query := `
		SELECT f.path, f.name, f.is_folder, f.size, f.mime_type, f.hash,
			   f.modified_at, f.created_at, f.last_scanned_at, f.text_preview, f.preview_sqlar, f.preview_status
		FROM pins p
		JOIN idx.files f ON f.path = p.file_path
		ORDER BY p.pinned_at DESC
	`

	rows, err := d.conn.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []FileRecord
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

		files = append(files, f)
	}

	return files, nil
}

// CountPins returns the number of pinned files
func (d *DB) CountPins() (int64, error) {
	var count int64
	err := d.conn.QueryRow("SELECT COUNT(*) FROM pins").Scan(&count)
	return count, err
}
