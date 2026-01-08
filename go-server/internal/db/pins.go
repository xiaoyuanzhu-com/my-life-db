package db

import (
	"database/sql"
)

// IsPinned checks if a file is pinned
func IsPinned(path string) (bool, error) {
	var count int
	err := GetDB().QueryRow("SELECT COUNT(*) FROM pins WHERE path = ?", path).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// AddPin pins a file
func AddPin(path string) error {
	_, err := GetDB().Exec(`
		INSERT INTO pins (path, created_at)
		VALUES (?, ?)
		ON CONFLICT(path) DO NOTHING
	`, path, NowUTC())
	return err
}

// RemovePin unpins a file
func RemovePin(path string) error {
	_, err := GetDB().Exec("DELETE FROM pins WHERE path = ?", path)
	return err
}

// GetAllPins retrieves all pinned files
func GetAllPins() ([]Pin, error) {
	rows, err := GetDB().Query(`
		SELECT path, created_at FROM pins ORDER BY created_at DESC
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

// GetPinnedFiles retrieves all pinned files with their file records
func GetPinnedFiles() ([]FileWithDigests, error) {
	query := `
		SELECT f.path, f.name, f.is_folder, f.size, f.mime_type, f.hash,
			   f.modified_at, f.created_at, f.last_scanned_at, f.text_preview, f.screenshot_sqlar,
			   p.created_at as pin_created_at
		FROM pins p
		JOIN files f ON f.path = p.path
		ORDER BY p.created_at DESC
	`

	rows, err := GetDB().Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []FileWithDigests
	for rows.Next() {
		var f FileRecord
		var isFolder int
		var size sql.NullInt64
		var hash, mimeType, textPreview, screenshotSqlar, lastScannedAt, pinCreatedAt sql.NullString

		err := rows.Scan(
			&f.Path, &f.Name, &isFolder, &size, &mimeType,
			&hash, &f.ModifiedAt, &f.CreatedAt, &lastScannedAt,
			&textPreview, &screenshotSqlar, &pinCreatedAt,
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

		// Get digests for this file
		digests, err := GetDigestsForFile(f.Path)
		if err != nil {
			return nil, err
		}

		files = append(files, FileWithDigests{
			FileRecord: f,
			Digests:    digests,
			IsPinned:   true,
		})
	}

	return files, nil
}

// CountPins returns the number of pinned files
func CountPins() (int64, error) {
	var count int64
	err := GetDB().QueryRow("SELECT COUNT(*) FROM pins").Scan(&count)
	return count, err
}
