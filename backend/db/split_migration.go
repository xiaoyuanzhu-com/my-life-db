package db

import (
	"database/sql"
	"fmt"
	"os"
	"strings"

	_ "github.com/mattn/go-sqlite3"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SplitConfig holds the file paths and driver configuration the split
// migration needs.
type SplitConfig struct {
	LegacyPath string // database.sqlite
	IndexPath  string // index.sqlite
	AppPath    string // app.sqlite

	// ExtensionPath / ExtensionDictDir are used when re-executing the legacy
	// DB's CREATE statements on the new index DB. If the legacy DB has
	// files_fts with the simple tokenizer (production), the simple extension
	// must be loaded to re-create the table on the tmp index DB. Empty in
	// tests (which seed plain FTS5 with no tokenize clause).
	ExtensionPath    string
	ExtensionDictDir string
}

// indexTables are the tables that move from the legacy DB to index.sqlite.
// All other tables stay in what becomes app.sqlite.
var indexTables = []string{"files", "files_fts", "sqlar", "digests"}

// MaybeRunSplitMigration detects whether the user has a pre-split single
// database.sqlite and migrates it to the index.sqlite + app.sqlite layout.
//
// Idempotent: detects fresh install, already-migrated, mid-copy crash, and
// post-commit-1 crash, and acts appropriately. Filesystem state is the
// source of truth; the only commit points are two atomic renames.
//
// Must be called BEFORE opening either index.sqlite or app.sqlite via db.Open.
func MaybeRunSplitMigration(cfg SplitConfig) error {
	tmpPath := cfg.IndexPath + ".tmp"

	// Always start by clearing any leftover .tmp from a crashed run. The .tmp
	// is only valid mid-call; on a fresh start we don't trust its contents.
	if _, err := os.Stat(tmpPath); err == nil {
		log.Info().Str("path", tmpPath).Msg("split-migration: removing leftover index.sqlite.tmp from crashed run")
		if err := os.Remove(tmpPath); err != nil {
			return fmt.Errorf("remove leftover tmp: %w", err)
		}
	}

	indexExists := fileExists(cfg.IndexPath)
	legacyExists := fileExists(cfg.LegacyPath)

	switch {
	case !legacyExists && !indexExists:
		// Fresh install — db.Open will create both DBs from migrations.
		return nil

	case !legacyExists && indexExists:
		// Already migrated, normal startup.
		return nil

	case legacyExists && indexExists:
		// Crashed between commit points: index already produced, but legacy
		// still has the index tables and hasn't been renamed yet. Finish
		// the cleanup phase.
		log.Info().Msg("split-migration: detected half-migrated state, completing cleanup")
		return finishLegacyCleanup(cfg)

	case legacyExists && !indexExists:
		// Full migration needed.
		log.Info().
			Str("legacy", cfg.LegacyPath).
			Str("index", cfg.IndexPath).
			Str("app", cfg.AppPath).
			Msg("split-migration: starting one-shot legacy → split migration")

		if err := buildIndexTmp(cfg, tmpPath); err != nil {
			// Leave .tmp for next startup to clean up; legacy untouched.
			return fmt.Errorf("build index tmp: %w", err)
		}

		// First commit point.
		if err := os.Rename(tmpPath, cfg.IndexPath); err != nil {
			return fmt.Errorf("rename index tmp → index.sqlite: %w", err)
		}
		log.Info().Msg("split-migration: commit point 1 reached (index.sqlite committed)")

		return finishLegacyCleanup(cfg)
	}

	return nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// driverNameForSplit returns the SQL driver name to use for split-migration
// connections. When ExtensionPath is set, registers and returns the simple
// driver (needed to re-create files_fts with the simple tokenizer). Otherwise
// uses bare sqlite3 (test environments that seed plain FTS5).
func driverNameForSplit(cfg SplitConfig) (string, error) {
	if cfg.ExtensionPath == "" {
		return "sqlite3", nil
	}
	if err := registerSimpleDriver(cfg.ExtensionPath, cfg.ExtensionDictDir); err != nil {
		return "", fmt.Errorf("register simple driver for split: %w", err)
	}
	return sqliteSimpleDriver, nil
}

// buildIndexTmp creates index.sqlite.tmp, copies each index table's schema
// verbatim from the legacy DB to the tmp file, then ATTACHes and copies
// rows. Verifies row counts. Does NOT rename the .tmp; the caller does that
// as the first commit point.
//
// Schema-from-legacy avoids depending on migration 028: whatever schema the
// legacy DB has (with whatever tokenizer/columns the running app produced)
// is what we replicate. This makes the migration robust to small schema
// drift between migration 028's canonical form and the legacy DB's actual
// post-migration state.
func buildIndexTmp(cfg SplitConfig, tmpPath string) error {
	driverName, err := driverNameForSplit(cfg)
	if err != nil {
		return err
	}

	// Open the legacy DB. We do all work through this connection so ATTACH
	// stays valid for all statements.
	legacyConn, err := sql.Open(driverName, cfg.LegacyPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return fmt.Errorf("open legacy: %w", err)
	}
	defer legacyConn.Close()

	if _, err := legacyConn.Exec(fmt.Sprintf("ATTACH DATABASE '%s' AS idx", tmpPath)); err != nil {
		return fmt.Errorf("attach tmp as idx: %w", err)
	}

	for _, table := range indexTables {
		if err := copyTable(legacyConn, table); err != nil {
			return err
		}
	}

	if _, err := legacyConn.Exec("DETACH DATABASE idx"); err != nil {
		return fmt.Errorf("detach idx: %w", err)
	}
	return nil
}

// copyTable recreates one table's schema in the attached `idx` DB and copies
// its rows over. Skips tables that don't exist in the legacy DB (defensive —
// older installs may predate certain migrations). Verifies row counts before
// returning success.
func copyTable(legacyConn *sql.DB, table string) error {
	// Find the parent CREATE statement in legacy's sqlite_master. Skip any
	// auxiliary entries (FTS5 shadow tables — those get recreated automatically
	// when the parent virtual table is created).
	var createSQL string
	err := legacyConn.QueryRow(
		`SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
		table,
	).Scan(&createSQL)
	if err == sql.ErrNoRows {
		log.Warn().Str("table", table).Msg("split-migration: legacy DB has no such table, skipping copy")
		return nil
	}
	if err != nil {
		return fmt.Errorf("read schema for %s: %w", table, err)
	}

	// Rewrite the CREATE to target the idx schema. The CREATE statement always
	// names the table as the first identifier after CREATE [VIRTUAL] TABLE
	// [IF NOT EXISTS]. Prefix it with "idx.".
	idxCreateSQL, err := rewriteCreateForSchema(createSQL, table, "idx")
	if err != nil {
		return fmt.Errorf("rewrite CREATE for %s: %w", table, err)
	}

	if _, err := legacyConn.Exec(idxCreateSQL); err != nil {
		return fmt.Errorf("create idx.%s: %w", table, err)
	}

	// Copy any non-parent CREATE statements for this table (e.g., indexes).
	rows, err := legacyConn.Query(
		`SELECT sql FROM sqlite_master
		 WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
		table,
	)
	if err != nil {
		return fmt.Errorf("list indexes for %s: %w", table, err)
	}
	var indexCreates []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			rows.Close()
			return fmt.Errorf("scan index sql for %s: %w", table, err)
		}
		indexCreates = append(indexCreates, s)
	}
	rows.Close()

	for _, s := range indexCreates {
		// Indexes attached to a schema-qualified table need their target
		// rewritten: "CREATE INDEX foo ON tbl(...)" → "CREATE INDEX idx.foo ON tbl(...)".
		// SQLite resolves `tbl` against the index's own schema.
		idxIndexSQL := rewriteIndexForSchema(s, "idx")
		if _, err := legacyConn.Exec(idxIndexSQL); err != nil {
			return fmt.Errorf("create index for idx.%s: %w", table, err)
		}
	}

	// Copy rows.
	copySQL := fmt.Sprintf("INSERT INTO idx.%s SELECT * FROM %s", table, table)
	if _, err := legacyConn.Exec(copySQL); err != nil {
		return fmt.Errorf("copy %s: %w", table, err)
	}

	// Verify row counts.
	var srcCount, dstCount int64
	if err := legacyConn.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&srcCount); err != nil {
		return fmt.Errorf("count src.%s: %w", table, err)
	}
	if err := legacyConn.QueryRow("SELECT COUNT(*) FROM idx." + table).Scan(&dstCount); err != nil {
		return fmt.Errorf("count idx.%s: %w", table, err)
	}
	if srcCount != dstCount {
		return fmt.Errorf("row count mismatch for %s: legacy=%d idx=%d", table, srcCount, dstCount)
	}
	log.Info().Str("table", table).Int64("rows", srcCount).Msg("split-migration: copied table to idx")
	return nil
}

// rewriteCreateForSchema turns "CREATE TABLE files (...)" into
// "CREATE TABLE idx.files (...)". Handles CREATE TABLE, CREATE VIRTUAL TABLE,
// and IF NOT EXISTS variants. Case-insensitive on the keywords; preserves
// the original casing in the rewritten statement.
func rewriteCreateForSchema(createSQL, tableName, schema string) (string, error) {
	upper := strings.ToUpper(createSQL)
	prefixes := []string{
		"CREATE TABLE IF NOT EXISTS " + strings.ToUpper(tableName),
		"CREATE TABLE " + strings.ToUpper(tableName),
		"CREATE VIRTUAL TABLE IF NOT EXISTS " + strings.ToUpper(tableName),
		"CREATE VIRTUAL TABLE " + strings.ToUpper(tableName),
	}
	for _, p := range prefixes {
		if i := strings.Index(upper, p); i >= 0 {
			// Everything up to and including the original prefix in the
			// real (non-uppercased) statement.
			origPrefix := createSQL[i : i+len(p)]
			// Replace the table-name suffix of the prefix with schema.tableName.
			rest := origPrefix[:len(origPrefix)-len(tableName)]
			return createSQL[:i] + rest + schema + "." + tableName + createSQL[i+len(p):], nil
		}
	}
	return "", fmt.Errorf("could not locate CREATE [VIRTUAL] TABLE prefix in: %s", createSQL[:min(80, len(createSQL))])
}

// rewriteIndexForSchema turns "CREATE INDEX foo ON ..." into
// "CREATE INDEX idx.foo ON ...". The ON clause's table reference is
// unqualified and resolves to the index's own schema, so it doesn't need
// rewriting.
func rewriteIndexForSchema(createSQL, schema string) string {
	upper := strings.ToUpper(createSQL)
	prefixes := []string{
		"CREATE UNIQUE INDEX IF NOT EXISTS ",
		"CREATE INDEX IF NOT EXISTS ",
		"CREATE UNIQUE INDEX ",
		"CREATE INDEX ",
	}
	for _, p := range prefixes {
		if strings.HasPrefix(upper, p) {
			return createSQL[:len(p)] + schema + "." + createSQL[len(p):]
		}
	}
	return createSQL
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// finishLegacyCleanup drops the index tables from the legacy DB, vacuums it,
// and renames it to app.sqlite. Idempotent (DROP IF EXISTS) so it's safe to
// re-run if the previous attempt crashed before the rename.
func finishLegacyCleanup(cfg SplitConfig) error {
	driverName, err := driverNameForSplit(cfg)
	if err != nil {
		return err
	}
	legacyConn, err := sql.Open(driverName, cfg.LegacyPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return fmt.Errorf("reopen legacy for cleanup: %w", err)
	}

	for _, table := range indexTables {
		if _, err := legacyConn.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			legacyConn.Close()
			return fmt.Errorf("drop %s from legacy: %w", table, err)
		}
	}
	if _, err := legacyConn.Exec("VACUUM"); err != nil {
		legacyConn.Close()
		return fmt.Errorf("vacuum legacy: %w", err)
	}
	if err := legacyConn.Close(); err != nil {
		return fmt.Errorf("close legacy after cleanup: %w", err)
	}

	// Second commit point.
	if err := os.Rename(cfg.LegacyPath, cfg.AppPath); err != nil {
		return fmt.Errorf("rename legacy → app.sqlite: %w", err)
	}
	log.Info().Msg("split-migration: commit point 2 reached (legacy → app.sqlite). Done.")
	return nil
}
