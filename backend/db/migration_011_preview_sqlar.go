package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     11,
		Description: "Rename screenshot_sqlar to preview_sqlar",
		Up:          migration011_previewSqlar,
	})
}

func migration011_previewSqlar(db *sql.DB) error {
	// Fresh installs already have preview_sqlar from migration 1.
	// Only rename if the old column name exists (Node.js upgrade path).
	var hasOldColumn bool
	err := db.QueryRow(`
		SELECT COUNT(*) > 0
		FROM pragma_table_info('files')
		WHERE name='screenshot_sqlar'
	`).Scan(&hasOldColumn)
	if err != nil {
		return err
	}
	if !hasOldColumn {
		return nil
	}
	_, err = db.Exec(`ALTER TABLE files RENAME COLUMN screenshot_sqlar TO preview_sqlar`)
	return err
}
