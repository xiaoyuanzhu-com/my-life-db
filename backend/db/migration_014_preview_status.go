package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     14,
		Description: "Add preview_status column for explicit preview state tracking",
		Up:          migration014_previewStatus,
		Target:      DBRoleIndex,
	})
}

func migration014_previewStatus(db *sql.DB) error {
	// Add preview_status column: NULL = not applicable, 'pending', 'ready', 'failed'
	_, err := db.Exec(`ALTER TABLE files ADD COLUMN preview_status TEXT`)
	if err != nil {
		return err
	}

	// Backfill: files that already have a preview → 'ready'
	_, err = db.Exec(`UPDATE files SET preview_status = 'ready' WHERE preview_sqlar IS NOT NULL`)
	if err != nil {
		return err
	}

	// Backfill: previewable files without a preview → 'pending'
	_, err = db.Exec(`
		UPDATE files SET preview_status = 'pending'
		WHERE preview_sqlar IS NULL
		  AND is_folder = 0
		  AND mime_type IS NOT NULL
		  AND (
			mime_type LIKE 'image/%'
			OR mime_type IN (
				'application/pdf',
				'application/epub+zip',
				'application/msword',
				'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				'application/vnd.ms-excel',
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
				'application/vnd.ms-powerpoint',
				'application/vnd.openxmlformats-officedocument.presentationml.presentation',
				'text/csv',
				'application/rtf',
				'text/html',
				'text/markdown'
			)
		  )
	`)
	return err
}
