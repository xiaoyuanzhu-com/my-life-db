package db

import (
	"database/sql"
	"fmt"
	"os"
)

// CompactIndex is an offline maintenance operation. The instance MUST be
// stopped: VACUUM needs exclusive access and temporary disk space. It applies
// index migrations before reclaiming freed FTS/preview pages and WAL space.
func CompactIndex(cfg Config) error {
	if _, err := os.Stat(cfg.Path); err != nil {
		return fmt.Errorf("index must already exist: %w", err)
	}
	driver := "sqlite3"
	if cfg.ExtensionPath != "" {
		if err := registerSimpleDriver(cfg.ExtensionPath, cfg.ExtensionDictDir); err != nil {
			return err
		}
		driver = sqliteSimpleDriver
	}
	conn, err := sql.Open(driver, cfg.Path+"?_busy_timeout=5000")
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetMaxOpenConns(1)
	conn.SetMaxIdleConns(1)
	// Acquire exclusive ownership BEFORE applying any destructive migration.
	// In WAL mode this also excludes existing readers. Keep ownership through
	// migrations, VACUUM and the final checkpoint on the same connection.
	if _, err := conn.Exec("PRAGMA locking_mode=EXCLUSIVE"); err != nil {
		return err
	}
	if _, err := conn.Exec("BEGIN EXCLUSIVE"); err != nil {
		return fmt.Errorf("stop the instance before compacting: %w", err)
	}
	if _, err := conn.Exec("COMMIT"); err != nil {
		return err
	}
	if err := runMigrations(conn, DBRoleIndex); err != nil {
		return err
	}
	return compactSQLite(conn)
}

// Explicit offline maintenance remains available for operators.
func compactSQLite(conn *sql.DB) error {
	checkpoint := func() error {
		var busy, frames, completed int
		if err := conn.QueryRow("PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &frames, &completed); err != nil {
			return err
		}
		if busy != 0 {
			return fmt.Errorf("checkpoint blocked by another connection; stop the instance before compacting")
		}
		return nil
	}
	if err := checkpoint(); err != nil {
		return err
	}
	if _, err := conn.Exec("VACUUM"); err != nil {
		return fmt.Errorf("compact index: %w", err)
	}
	return checkpoint()
}
