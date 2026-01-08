import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migration 022: Drop content_type column from qdrant_documents
 *
 * Purpose: Remove unnecessary content_type classification
 *
 * Rationale:
 * - content_type ('url', 'text', 'pdf', 'image', etc.) is redundant
 * - MIME type is already stored in files table
 * - File path extension provides sufficient type hints
 * - Simplifies codebase by removing unused classification layer
 */
const migration = {
  version: 22,
  description: 'Drop content_type column from qdrant_documents',

  async up(db: BetterSqlite3.Database) {
    // SQLite doesn't support DROP COLUMN directly
    // We need to recreate the table without the content_type column
    db.exec(`
      -- Create new table without content_type
      CREATE TABLE qdrant_documents_new (
        -- Primary key: {file_path}:{source_type}:{chunk_index}
        document_id TEXT PRIMARY KEY,

        -- File reference (file-centric architecture)
        file_path TEXT NOT NULL,

        -- Source type: content, summary, or tags
        source_type TEXT NOT NULL CHECK(source_type IN ('content', 'summary', 'tags')),

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

        -- Additional metadata (JSON)
        metadata_json TEXT,

        -- Qdrant sync status
        embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK(embedding_status IN ('pending', 'indexing', 'indexed', 'deleting', 'deleted', 'error')),
        embedding_version INTEGER NOT NULL DEFAULT 0,
        qdrant_point_id TEXT,
        qdrant_indexed_at TEXT,
        qdrant_error TEXT,

        -- Timestamps
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Copy data from old table (excluding content_type column)
      INSERT INTO qdrant_documents_new (
        document_id, file_path, source_type, chunk_index, chunk_count,
        chunk_text, span_start, span_end, overlap_tokens, word_count,
        token_count, content_hash, metadata_json, embedding_status,
        embedding_version, qdrant_point_id, qdrant_indexed_at, qdrant_error,
        created_at, updated_at
      )
      SELECT
        document_id, file_path, source_type, chunk_index, chunk_count,
        chunk_text, span_start, span_end, overlap_tokens, word_count,
        token_count, content_hash, metadata_json, embedding_status,
        embedding_version, qdrant_point_id, qdrant_indexed_at, qdrant_error,
        created_at, updated_at
      FROM qdrant_documents;

      -- Drop old table
      DROP TABLE qdrant_documents;

      -- Rename new table
      ALTER TABLE qdrant_documents_new RENAME TO qdrant_documents;

      -- Recreate indexes
      CREATE INDEX idx_qdrant_file_path ON qdrant_documents(file_path);
      CREATE INDEX idx_qdrant_file_source ON qdrant_documents(file_path, source_type);
      CREATE INDEX idx_qdrant_embedding_status ON qdrant_documents(embedding_status)
        WHERE embedding_status != 'indexed';
    `);
  },

  async down(db: BetterSqlite3.Database) {
    // Recreate table with content_type column (restore old schema)
    db.exec(`
      -- Create table with content_type
      CREATE TABLE qdrant_documents_new (
        document_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('content', 'summary', 'tags')),
        chunk_index INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        span_start INTEGER NOT NULL,
        span_end INTEGER NOT NULL,
        overlap_tokens INTEGER NOT NULL,
        word_count INTEGER NOT NULL,
        token_count INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text' CHECK(content_type IN ('url', 'text', 'pdf', 'image', 'audio', 'video', 'mixed')),
        metadata_json TEXT,
        embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK(embedding_status IN ('pending', 'indexing', 'indexed', 'deleting', 'deleted', 'error')),
        embedding_version INTEGER NOT NULL DEFAULT 0,
        qdrant_point_id TEXT,
        qdrant_indexed_at TEXT,
        qdrant_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Copy data back (with default content_type='text')
      INSERT INTO qdrant_documents_new (
        document_id, file_path, source_type, chunk_index, chunk_count,
        chunk_text, span_start, span_end, overlap_tokens, word_count,
        token_count, content_hash, content_type, metadata_json, embedding_status,
        embedding_version, qdrant_point_id, qdrant_indexed_at, qdrant_error,
        created_at, updated_at
      )
      SELECT
        document_id, file_path, source_type, chunk_index, chunk_count,
        chunk_text, span_start, span_end, overlap_tokens, word_count,
        token_count, content_hash, 'text' as content_type, metadata_json, embedding_status,
        embedding_version, qdrant_point_id, qdrant_indexed_at, qdrant_error,
        created_at, updated_at
      FROM qdrant_documents;

      DROP TABLE qdrant_documents;
      ALTER TABLE qdrant_documents_new RENAME TO qdrant_documents;

      -- Recreate indexes
      CREATE INDEX idx_qdrant_file_path ON qdrant_documents(file_path);
      CREATE INDEX idx_qdrant_file_source ON qdrant_documents(file_path, source_type);
      CREATE INDEX idx_qdrant_embedding_status ON qdrant_documents(embedding_status)
        WHERE embedding_status != 'indexed';
    `);
  },
};

export default migration;
