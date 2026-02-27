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
	_, err := db.Exec(`ALTER TABLE files RENAME COLUMN screenshot_sqlar TO preview_sqlar`)
	return err
}
