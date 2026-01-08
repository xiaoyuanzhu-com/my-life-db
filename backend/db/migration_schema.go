package db

import (
	"database/sql"
)

func init() {
	// This migration creates the complete current schema
	// It's designed to either:
	// 1. Create fresh schema for new databases
	// 2. Be skipped for databases already migrated by Node.js
	//
	// The Go server expects an existing database that was initialized
	// by the Node.js migrations. This migration is a safety fallback.

	RegisterMigration(Migration{
		Version:     1000, // High version to not conflict with Node.js migrations
		Description: "Go server baseline schema (creates tables if they don't exist)",
		Up: func(db *sql.DB) error {
			// All tables use IF NOT EXISTS to be safe with existing databases

			// Settings table
			_, err := db.Exec(`
				CREATE TABLE IF NOT EXISTS settings (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL,
					updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
				)
			`)
			if err != nil {
				return err
			}

			// Files table - rebuildable file metadata cache
			_, err = db.Exec(`
				CREATE TABLE IF NOT EXISTS files (
					path TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					is_folder INTEGER NOT NULL DEFAULT 0,
					size INTEGER,
					mime_type TEXT,
					hash TEXT,
					modified_at TEXT NOT NULL,
					created_at TEXT NOT NULL,
					last_scanned_at TEXT NOT NULL,
					text_preview TEXT,
					screenshot_sqlar TEXT
				);
				CREATE INDEX IF NOT EXISTS idx_files_path_prefix ON files(path);
				CREATE INDEX IF NOT EXISTS idx_files_is_folder ON files(is_folder);
				CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);
				CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);
			`)
			if err != nil {
				return err
			}

			// Digests table
			_, err = db.Exec(`
				CREATE TABLE IF NOT EXISTS digests (
					id TEXT PRIMARY KEY,
					file_path TEXT NOT NULL,
					digester TEXT NOT NULL,
					status TEXT NOT NULL DEFAULT 'todo',
					content TEXT,
					sqlar_name TEXT,
					error TEXT,
					attempts INTEGER DEFAULT 0,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					UNIQUE(file_path, digester)
				);
				CREATE INDEX IF NOT EXISTS idx_digests_file_path ON digests(file_path);
				CREATE INDEX IF NOT EXISTS idx_digests_digester ON digests(digester);
				CREATE INDEX IF NOT EXISTS idx_digests_status ON digests(status);
			`)
			if err != nil {
				return err
			}

			// SQLAR table - SQLite Archive format for binary digests
			_, err = db.Exec(`
				CREATE TABLE IF NOT EXISTS sqlar (
					name TEXT PRIMARY KEY,
					mode INTEGER,
					mtime INTEGER,
					sz INTEGER,
					data BLOB
				)
			`)
			if err != nil {
				return err
			}

			// Pins table
			_, err = db.Exec(`
				CREATE TABLE IF NOT EXISTS pins (
					path TEXT PRIMARY KEY,
					created_at TEXT NOT NULL
				)
			`)
			if err != nil {
				return err
			}

			// Sessions table
			_, err = db.Exec(`
				CREATE TABLE IF NOT EXISTS sessions (
					id TEXT PRIMARY KEY,
					password_hash TEXT,
					created_at TEXT NOT NULL
				)
			`)
			if err != nil {
				return err
			}

			// People table
			_, err = db.Exec(`
				CREATE TABLE IF NOT EXISTS people (
					id TEXT PRIMARY KEY,
					display_name TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`)
			if err != nil {
				return err
			}

			// People clusters table
			_, err = db.Exec(`
				CREATE TABLE IF NOT EXISTS people_clusters (
					id TEXT PRIMARY KEY,
					people_id TEXT,
					cluster_type TEXT NOT NULL,
					centroid BLOB,
					sample_count INTEGER DEFAULT 0,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					FOREIGN KEY (people_id) REFERENCES people(id) ON DELETE SET NULL
				)
			`)
			if err != nil {
				return err
			}

			// People embeddings table
			_, err = db.Exec(`
				CREATE TABLE IF NOT EXISTS people_embeddings (
					id TEXT PRIMARY KEY,
					cluster_id TEXT,
					embedding_type TEXT NOT NULL,
					source_path TEXT NOT NULL,
					source_offset TEXT,
					vector BLOB NOT NULL,
					created_at TEXT NOT NULL,
					FOREIGN KEY (cluster_id) REFERENCES people_clusters(id) ON DELETE SET NULL
				)
			`)
			if err != nil {
				return err
			}

			// Meili documents table
			_, err = db.Exec(`
				CREATE TABLE IF NOT EXISTS meili_documents (
					document_id TEXT PRIMARY KEY,
					file_path TEXT NOT NULL,
					content_hash TEXT,
					status TEXT DEFAULT 'pending',
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_meili_documents_file_path ON meili_documents(file_path);
				CREATE INDEX IF NOT EXISTS idx_meili_documents_status ON meili_documents(status);
			`)
			if err != nil {
				return err
			}

			// Qdrant documents table
			_, err = db.Exec(`
				CREATE TABLE IF NOT EXISTS qdrant_documents (
					document_id TEXT PRIMARY KEY,
					file_path TEXT NOT NULL,
					source_type TEXT,
					content_hash TEXT,
					status TEXT DEFAULT 'pending',
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_qdrant_documents_file_path ON qdrant_documents(file_path);
				CREATE INDEX IF NOT EXISTS idx_qdrant_documents_status ON qdrant_documents(status);
			`)
			if err != nil {
				return err
			}

			// Processing locks table
			_, err = db.Exec(`
				CREATE TABLE IF NOT EXISTS processing_locks (
					file_path TEXT PRIMARY KEY,
					owner TEXT NOT NULL,
					acquired_at TEXT NOT NULL
				)
			`)
			if err != nil {
				return err
			}

			return nil
		},
	})
}
