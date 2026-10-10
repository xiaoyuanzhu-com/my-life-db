package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version: 40, Target: DBRoleIndex,
		Description: "Persist monthly background index maintenance state",
		Up: func(conn *sql.DB) error {
			_, err := conn.Exec(`CREATE TABLE IF NOT EXISTS index_maintenance (
    name TEXT PRIMARY KEY,
    last_checked_at INTEGER NOT NULL DEFAULT 0,
    pending INTEGER NOT NULL DEFAULT 1
   );
   INSERT OR IGNORE INTO index_maintenance(name) VALUES ('space');`)
			return err
		},
	})
}
