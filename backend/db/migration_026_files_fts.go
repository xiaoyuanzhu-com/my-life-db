package db

import (
	"database/sql"
	"fmt"
)

// Migration 026: replace the meili_documents staging table with a SQLite FTS5
// virtual table named files_fts, populated using the wangfenjin/simple
// tokenizer (jieba-based Chinese segmentation + English).
//
// Pre-conditions: the simple SQLite extension MUST be loaded for the
// connection running this migration; runMigrations() runs against a
// connection from the pool, and connections in this pool come pre-loaded
// with libsimple via the ConnectHook in connection.go. If the extension is
// missing, CREATE VIRTUAL TABLE will fail with "no such tokenizer: simple".
//
// We use `tokenize = 'simple 0'` — pinyin disabled — to keep the index
// compact. jieba_query() at query time still gives us word-level precision
// for Chinese; pinyin search can be added later by recreating the index
// with `tokenize = 'simple 1'` if the user wants it.
//
// After populating files_fts from meili_documents we drop the staging
// table outright. There is no rollback once that DROP runs — backups
// belong upstream of this migration.
func init() {
	RegisterMigration(Migration{
		Version:     26,
		Description: "Replace meili_documents with files_fts FTS5 virtual table",
		Up:          migration026Up,
	})
}

func migration026Up(db *sql.DB) error {
	// Create the FTS5 virtual table backed by the simple tokenizer.
	// document_id is UNINDEXED — we only filter by it in WHERE clauses,
	// no need to tokenize. Both file_path and content participate in
	// full-text search and highlight().
	_, err := db.Exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
			document_id UNINDEXED,
			file_path,
			content,
			tokenize = 'simple 0'
		)
	`)
	if err != nil {
		return fmt.Errorf("create files_fts: %w", err)
	}

	// Copy existing rows from the legacy staging table when present.
	// We check for the table first so this migration is safe on a fresh
	// install where meili_documents was never created (in case migration
	// 002 is later removed).
	var legacyExists int
	err = db.QueryRow(`
		SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'table' AND name = 'meili_documents'
	`).Scan(&legacyExists)
	if err != nil {
		return fmt.Errorf("check meili_documents existence: %w", err)
	}

	if legacyExists > 0 {
		// Bulk-copy content into the FTS5 index. We do this inside a single
		// statement so SQLite can stream rows without buffering everything
		// into Go memory.
		if _, err := db.Exec(`
			INSERT INTO files_fts(document_id, file_path, content)
			SELECT document_id, file_path, content
			FROM meili_documents
		`); err != nil {
			return fmt.Errorf("backfill files_fts from meili_documents: %w", err)
		}

		if _, err := db.Exec(`DROP TABLE meili_documents`); err != nil {
			return fmt.Errorf("drop meili_documents: %w", err)
		}
	}

	// Clean up the orphan setting key, if present. Harmless if missing.
	_, _ = db.Exec(`DELETE FROM settings WHERE key = 'meili_host'`)

	return nil
}
