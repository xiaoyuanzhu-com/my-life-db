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
	// Create qdrant_documents table for chunked vector search
	_, err := db.Exec(`
		CREATE TABLE qdrant_documents (
			-- Primary key: {file_path}:{source_type}:{chunk_index}
			document_id TEXT PRIMARY KEY,

			-- File reference
			file_path TEXT NOT NULL,

			-- Source type (flexible, no enum constraint)
			-- Examples: url-crawl-content, doc-to-markdown, image-ocr, image-captioning,
			--           image-objects, speech-recognition, summary, tags, file
			source_type TEXT NOT NULL,

			-- Chunking metadata
			chunk_index INTEGER NOT NULL,
			chunk_count INTEGER NOT NULL,
			chunk_text TEXT NOT NULL,

			-- Span tracking (character positions in original text)
			span_start INTEGER NOT NULL,
			span_end INTEGER NOT NULL,
			overlap_tokens INTEGER NOT NULL,

			-- Chunk statistics
			word_count INTEGER NOT NULL,
			token_count INTEGER NOT NULL,
			content_hash TEXT NOT NULL,

			-- Optional metadata (JSON string)
			metadata_json TEXT,

			-- Embedding status tracking
			embedding_status TEXT NOT NULL DEFAULT 'pending'
				CHECK(embedding_status IN ('pending', 'indexing', 'indexed', 'deleting', 'deleted', 'error')),
			embedding_version INTEGER NOT NULL DEFAULT 0,
			qdrant_point_id TEXT,
			qdrant_indexed_at TEXT,
			qdrant_error TEXT,

			-- Timestamps
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`)
	if err != nil {
		return err
	}

	// Create indexes for qdrant_documents
	_, err = db.Exec(`CREATE INDEX idx_qdrant_documents_file_path ON qdrant_documents(file_path)`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`CREATE INDEX idx_qdrant_documents_status ON qdrant_documents(embedding_status)`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`CREATE INDEX idx_qdrant_documents_file_source ON qdrant_documents(file_path, source_type)`)
	if err != nil {
		return err
	}

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
