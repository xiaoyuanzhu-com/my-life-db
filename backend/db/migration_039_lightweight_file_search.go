package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version: 39, Target: DBRoleIndex,
		Description: "Retire file-content FTS and disposable SQLAR previews; preserve session search",
		Up:          migration039Up,
	})
}

func migration039Up(conn *sql.DB) error {
	tx, err := conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{
		`DROP TABLE IF EXISTS files_fts`,
		// Only generated previews are disposable. Other archived resources survive.
		`DELETE FROM sqlar WHERE substr(name,17,9) = '/preview/'
		 AND substr(name,1,16) NOT GLOB '*[^0-9a-f]*'`,
		`UPDATE files SET preview_sqlar = NULL, preview_status = NULL WHERE preview_sqlar IS NOT NULL OR preview_status IS NOT NULL`,
	} {
		if _, err := tx.Exec(q); err != nil {
			return err
		}
	}
	return tx.Commit()
}
