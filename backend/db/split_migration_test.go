package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// seedLegacyDB creates a fixture pre-split database with the same schema
// migration 028 produces (index half) plus a minimal app-side schema.
// Populates each index table with one row so the migration's row-count
// verification has something to check.
func seedLegacyDB(t *testing.T, path string) {
	t.Helper()
	conn, err := sql.Open("sqlite3", path+"?_journal_mode=WAL")
	if err != nil {
		t.Fatalf("open legacy: %v", err)
	}
	defer conn.Close()

	// Index tables with the same schema as migration 028.
	stmts := []string{
		`CREATE TABLE files (
			path TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			is_folder INTEGER NOT NULL DEFAULT 0,
			size INTEGER,
			mime_type TEXT,
			hash TEXT,
			modified_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			last_scanned_at INTEGER,
			text_preview TEXT,
			preview_sqlar TEXT,
			preview_status TEXT
		)`,
		`CREATE TABLE digests (
			id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL,
			digester TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'todo',
			content TEXT,
			sqlar_name TEXT,
			error TEXT,
			attempts INTEGER DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(file_path, digester)
		)`,
		`CREATE TABLE sqlar (
			name TEXT PRIMARY KEY,
			mode INT,
			mtime INT,
			sz INT,
			data BLOB
		)`,
		`CREATE VIRTUAL TABLE files_fts USING fts5(
			document_id UNINDEXED,
			file_path,
			content
		)`,

		// App-side tables (just a couple for verification).
		`CREATE TABLE pins (id TEXT PRIMARY KEY, file_path TEXT UNIQUE, pinned_at INTEGER, created_at INTEGER)`,
		`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`,

		// One row per table.
		`INSERT INTO files (path, name, is_folder, modified_at, created_at) VALUES ('a.txt', 'a.txt', 0, 1700000000, 1700000000)`,
		`INSERT INTO files_fts (document_id, file_path, content) VALUES ('1', 'a.txt', 'hello world')`,
		`INSERT INTO sqlar (name, mode, mtime, sz, data) VALUES ('preview/a', 0, 0, 0, X'00')`,
		`INSERT INTO digests (id, file_path, digester, content, status, created_at, updated_at) VALUES ('d1', 'a.txt', 'markdown', 'hello world', 'ready', 1700000000, 1700000000)`,
		`INSERT INTO pins VALUES ('p1', 'a.txt', 1700000000, 1700000000)`,
		`INSERT INTO settings VALUES ('foo', 'bar')`,
	}
	for _, s := range stmts {
		if _, err := conn.Exec(s); err != nil {
			t.Fatalf("seed %q: %v", s[:60], err)
		}
	}
}

func TestSplitMigration_FreshInstall(t *testing.T) {
	dir := t.TempDir()
	cfg := SplitConfig{
		LegacyPath: filepath.Join(dir, "database.sqlite"),
		IndexPath:  filepath.Join(dir, "index.sqlite"),
		AppPath:    filepath.Join(dir, "app.sqlite"),
	}

	if err := MaybeRunSplitMigration(cfg); err != nil {
		t.Fatalf("MaybeRunSplitMigration: %v", err)
	}

	// No legacy DB → no migration runs → no files created by this function.
	if _, err := os.Stat(cfg.IndexPath); !os.IsNotExist(err) {
		t.Fatalf("expected no index.sqlite on fresh install, got err=%v", err)
	}
	if _, err := os.Stat(cfg.AppPath); !os.IsNotExist(err) {
		t.Fatalf("expected no app.sqlite on fresh install, got err=%v", err)
	}
}

func TestSplitMigration_AlreadyMigrated(t *testing.T) {
	dir := t.TempDir()
	cfg := SplitConfig{
		LegacyPath: filepath.Join(dir, "database.sqlite"),
		IndexPath:  filepath.Join(dir, "index.sqlite"),
		AppPath:    filepath.Join(dir, "app.sqlite"),
	}
	// Simulate already-migrated state: both new DBs exist, no legacy.
	if err := os.WriteFile(cfg.IndexPath, []byte("dummy"), 0644); err != nil {
		t.Fatalf("seed index: %v", err)
	}

	if err := MaybeRunSplitMigration(cfg); err != nil {
		t.Fatalf("MaybeRunSplitMigration: %v", err)
	}

	// index.sqlite untouched.
	data, _ := os.ReadFile(cfg.IndexPath)
	if string(data) != "dummy" {
		t.Fatalf("index.sqlite was modified: %q", data)
	}
}

func TestSplitMigration_ExistingUserMigratesData(t *testing.T) {
	dir := t.TempDir()
	cfg := SplitConfig{
		LegacyPath: filepath.Join(dir, "database.sqlite"),
		IndexPath:  filepath.Join(dir, "index.sqlite"),
		AppPath:    filepath.Join(dir, "app.sqlite"),
	}
	seedLegacyDB(t, cfg.LegacyPath)

	if err := MaybeRunSplitMigration(cfg); err != nil {
		t.Fatalf("MaybeRunSplitMigration: %v", err)
	}

	if _, err := os.Stat(cfg.LegacyPath); !os.IsNotExist(err) {
		t.Fatalf("legacy DB should be renamed away, got err=%v", err)
	}
	if _, err := os.Stat(cfg.AppPath); err != nil {
		t.Fatalf("app.sqlite should exist: %v", err)
	}
	if _, err := os.Stat(cfg.IndexPath); err != nil {
		t.Fatalf("index.sqlite should exist: %v", err)
	}

	// Verify index DB has the index tables with their seeded row.
	idx, _ := sql.Open("sqlite3", cfg.IndexPath)
	defer idx.Close()
	for _, tbl := range []string{"files", "files_fts", "sqlar", "digests"} {
		var n int
		if err := idx.QueryRow("SELECT COUNT(*) FROM " + tbl).Scan(&n); err != nil {
			t.Fatalf("count idx.%s: %v", tbl, err)
		}
		if n != 1 {
			t.Fatalf("idx.%s: want 1 row, got %d", tbl, n)
		}
	}

	// Verify app DB no longer has the index tables.
	app, _ := sql.Open("sqlite3", cfg.AppPath)
	defer app.Close()
	for _, tbl := range []string{"files", "files_fts", "sqlar", "digests"} {
		var n int
		err := app.QueryRow("SELECT COUNT(*) FROM " + tbl).Scan(&n)
		if err == nil {
			t.Fatalf("app.%s should be dropped, but exists with %d rows", tbl, n)
		}
	}
	// App DB still has app tables with their data.
	for _, tbl := range []string{"pins", "settings"} {
		var n int
		if err := app.QueryRow("SELECT COUNT(*) FROM " + tbl).Scan(&n); err != nil {
			t.Fatalf("count app.%s: %v", tbl, err)
		}
		if n != 1 {
			t.Fatalf("app.%s: want 1 row, got %d", tbl, n)
		}
	}
}

func TestSplitMigration_RecoversFromCrashedTmp(t *testing.T) {
	dir := t.TempDir()
	cfg := SplitConfig{
		LegacyPath: filepath.Join(dir, "database.sqlite"),
		IndexPath:  filepath.Join(dir, "index.sqlite"),
		AppPath:    filepath.Join(dir, "app.sqlite"),
	}
	seedLegacyDB(t, cfg.LegacyPath)

	// Simulate a crashed previous run: leftover .tmp file with garbage.
	tmpPath := cfg.IndexPath + ".tmp"
	if err := os.WriteFile(tmpPath, []byte("garbage"), 0644); err != nil {
		t.Fatalf("seed tmp: %v", err)
	}

	if err := MaybeRunSplitMigration(cfg); err != nil {
		t.Fatalf("MaybeRunSplitMigration: %v", err)
	}

	// Migration should have cleaned up .tmp and finished successfully.
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Fatalf("tmp should be removed, got err=%v", err)
	}
	if _, err := os.Stat(cfg.IndexPath); err != nil {
		t.Fatalf("index.sqlite should exist: %v", err)
	}
	if _, err := os.Stat(cfg.AppPath); err != nil {
		t.Fatalf("app.sqlite should exist: %v", err)
	}
}

func TestSplitMigration_RecoversFromHalfMigratedState(t *testing.T) {
	// Simulates crash AFTER index.sqlite was committed but BEFORE legacy
	// was renamed to app.sqlite. On next startup, MaybeRunSplitMigration
	// should detect this state and finish the cleanup (drop index tables
	// from legacy, rename legacy to app).
	dir := t.TempDir()
	cfg := SplitConfig{
		LegacyPath: filepath.Join(dir, "database.sqlite"),
		IndexPath:  filepath.Join(dir, "index.sqlite"),
		AppPath:    filepath.Join(dir, "app.sqlite"),
	}

	// Set up: legacy DB still has index tables, AND index.sqlite already exists
	// (committed) with the same data.
	seedLegacyDB(t, cfg.LegacyPath)

	// Simulate that index.sqlite was already produced (commit point 1 reached).
	indexConn, _ := sql.Open("sqlite3", cfg.IndexPath+"?_journal_mode=WAL")
	for _, s := range []string{
		`CREATE TABLE files (path TEXT PRIMARY KEY, name TEXT, is_folder INTEGER, modified_at INTEGER, created_at INTEGER)`,
		`CREATE TABLE digests (id TEXT PRIMARY KEY)`,
		`CREATE TABLE sqlar (name TEXT PRIMARY KEY)`,
		`CREATE VIRTUAL TABLE files_fts USING fts5(document_id UNINDEXED, file_path, content)`,
	} {
		if _, err := indexConn.Exec(s); err != nil {
			t.Fatalf("seed index: %v", err)
		}
	}
	indexConn.Close()

	if err := MaybeRunSplitMigration(cfg); err != nil {
		t.Fatalf("MaybeRunSplitMigration: %v", err)
	}

	// Legacy should be renamed to app.sqlite.
	if _, err := os.Stat(cfg.LegacyPath); !os.IsNotExist(err) {
		t.Fatalf("legacy should be renamed away, got err=%v", err)
	}
	if _, err := os.Stat(cfg.AppPath); err != nil {
		t.Fatalf("app.sqlite should exist: %v", err)
	}
	// App DB should NOT have the index tables anymore.
	app, _ := sql.Open("sqlite3", cfg.AppPath)
	defer app.Close()
	var n int
	if err := app.QueryRow("SELECT COUNT(*) FROM files").Scan(&n); err == nil {
		t.Fatalf("app.files should be dropped after recovery, got %d rows", n)
	}
}
