package db

import (
	"database/sql"
)

func init() {
	RegisterMigration(Migration{
		Version:     2,
		Description: "Create qdrant_documents and meili_documents tables for search indexing",
		Up:          migration002Up,
	})
}

func migration002Up(db *sql.DB) error {
	// Create meili_documents table for full-text keyword search (1:1 file mapping)
	_, err = db.Exec(`
		CREATE TABLE meili_documents (
			document_id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL UNIQUE,

			-- Content fields (embedded from digests)
			content TEXT NOT NULL,
			summary TEXT,
			tags TEXT,
			content_hash TEXT NOT NULL,
			word_count INTEGER NOT NULL,

			-- Metadata
			mime_type TEXT,
			metadata_json TEXT,

			-- Meilisearch sync status
			meili_status TEXT NOT NULL DEFAULT 'pending'
				CHECK(meili_status IN ('pending', 'indexing', 'indexed', 'deleting', 'deleted', 'error')),
			meili_task_id TEXT,
			meili_indexed_at TEXT,
			meili_error TEXT,

			-- Timestamps
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`)
	if err != nil {
		return err
	}

	// Create indexes for meili_documents
	_, err = db.Exec(`CREATE INDEX idx_meili_documents_file_path ON meili_documents(file_path)`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`CREATE INDEX idx_meili_documents_status ON meili_documents(meili_status)`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`CREATE INDEX idx_meili_documents_hash ON meili_documents(content_hash)`)
	if err != nil {
		return err
	}

	return nil
}
