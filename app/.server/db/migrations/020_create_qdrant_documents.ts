import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migration 020: Create qdrant_documents table
 *
 * Purpose: Store chunked documents for Qdrant vector search (semantic search)
 *
 * Key differences from meili_documents:
 * - CHUNKED text storage (800-1000 tokens per chunk) vs full text
 * - Includes chunk_index, chunk_count, overlap tracking
 * - embedding_status (not meili_status)
 * - qdrant_point_id for Qdrant collection reference
 * - embedding_version for model updates
 *
 * Design rationale:
 * - Separate table from meili_documents for clarity and independence
 * - File-centric: uses file_path (no entry_id/library_id)
 * - Chunking required for embedding models (context window limits)
 * - Overlap prevents semantic loss at boundaries
 */
const migration = {
  version: 20,
  description: 'Create qdrant_documents table for Qdrant semantic search',

  async up(db: BetterSqlite3.Database) {
  db.exec(`
    -- Create qdrant_documents table for chunked vector search
    CREATE TABLE qdrant_documents (
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

      -- Content classification
      content_type TEXT NOT NULL CHECK(content_type IN ('url', 'text', 'pdf', 'image', 'audio', 'video', 'mixed')),

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

    -- Index on file_path for looking up all chunks of a file
    CREATE INDEX idx_qdrant_file_path ON qdrant_documents(file_path);

    -- Composite index for file + source lookups
    CREATE INDEX idx_qdrant_file_source ON qdrant_documents(file_path, source_type);

    -- Partial index on embedding_status for efficient queue queries
    -- Only indexes non-indexed documents (pending, indexing, error)
    CREATE INDEX idx_qdrant_embedding_status ON qdrant_documents(embedding_status)
      WHERE embedding_status != 'indexed';
  `);
  },

  async down(db: BetterSqlite3.Database) {
    // Drop qdrant_documents table and all indexes
    db.exec(`
      DROP INDEX IF EXISTS idx_qdrant_embedding_status;
      DROP INDEX IF EXISTS idx_qdrant_file_source;
      DROP INDEX IF EXISTS idx_qdrant_file_path;
      DROP TABLE IF EXISTS qdrant_documents;
    `);
  },
};

export default migration;
