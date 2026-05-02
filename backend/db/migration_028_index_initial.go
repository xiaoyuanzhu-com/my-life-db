package db

import (
	"database/sql"
	"fmt"
)

func init() {
	RegisterMigration(Migration{
		Version:     28,
		Description: "Initial schema for index DB (files, files_fts, sqlar, digests)",
		Up:          migration028Up,
		Target:      DBRoleIndex,
	})
}

// migration028Up creates the index-DB schema in its FINAL form (after all
// historical mutations from migrations 001, 010, 011, 014, 027 are applied).
//
// All statements are idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX
// IF NOT EXISTS) so this migration is safe to run on either:
//   - a fresh index.sqlite (creates everything), or
//   - an index.sqlite populated by Task 10's split migration (no-op since
//     tables already exist with the final schema).
func migration028Up(db *sql.DB) error {
	stmts := []string{
		// files: final schema after migrations 001, 010, 011, 014.
		// Timestamps are INTEGER (epoch ms) per migration 010.
		// preview_sqlar replaced the original screenshot_sqlar in migration 011.
		// preview_status was added in migration 014.
		`CREATE TABLE IF NOT EXISTS files (
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
		`CREATE INDEX IF NOT EXISTS idx_files_path_prefix ON files(path)`,
		`CREATE INDEX IF NOT EXISTS idx_files_is_folder ON files(is_folder)`,
		`CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at)`,
		`CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at)`,

		// digests: final schema after migrations 001, 010.
		// Default status 'todo' matches migration 010's CREATE TABLE.
		`CREATE TABLE IF NOT EXISTS digests (
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
		`CREATE INDEX IF NOT EXISTS idx_digests_file_path ON digests(file_path)`,
		`CREATE INDEX IF NOT EXISTS idx_digests_digester ON digests(digester)`,
		`CREATE INDEX IF NOT EXISTS idx_digests_status ON digests(status)`,

		// sqlar: standard SQLite Archive layout from migration 001.
		`CREATE TABLE IF NOT EXISTS sqlar (
			name TEXT PRIMARY KEY,
			mode INT,
			mtime INT,
			sz INT,
			data BLOB
		)`,

		// files_fts: FTS5 virtual table from migration 027.
		// Uses the wangfenjin/simple tokenizer (jieba-based Chinese segmentation
		// + English). Pinyin is disabled ('simple 0') to keep the index compact.
		// document_id is UNINDEXED — only used in WHERE clauses, no need to
		// tokenize.
		`CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
			document_id UNINDEXED,
			file_path,
			content,
			tokenize = 'simple 0'
		)`,
	}

	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			// Truncate the SQL in the error to keep messages readable.
			snippet := s
			if len(snippet) > 60 {
				snippet = snippet[:60]
			}
			return fmt.Errorf("migration028: exec %q: %w", snippet, err)
		}
	}
	return nil
}
