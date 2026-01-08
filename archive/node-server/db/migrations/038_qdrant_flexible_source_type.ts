import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migration 038: Remove source_type constraint from qdrant_documents
 *
 * Purpose: Allow any source type (digester name) instead of just 'content', 'summary', 'tags'
 *
 * This enables indexing each digest source independently:
 * - image-ocr, image-captioning, image-objects each get their own chunks
 * - Better semantic separation for search
 * - Clearer provenance of indexed content
 */
const migration = {
  version: 38,
  description: 'Remove source_type constraint from qdrant_documents',

  async up(db: BetterSqlite3.Database) {
    // SQLite doesn't support ALTER TABLE to drop constraints
    // Need to recreate the table without the CHECK constraint
    db.exec(`
      -- Create new table without source_type constraint
      CREATE TABLE qdrant_documents_new (
        document_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        source_type TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        span_start INTEGER NOT NULL,
        span_end INTEGER NOT NULL,
        overlap_tokens INTEGER NOT NULL,
        word_count INTEGER NOT NULL,
        token_count INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        metadata_json TEXT,
        embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK(embedding_status IN ('pending', 'indexing', 'indexed', 'deleting', 'deleted', 'error')),
        embedding_version INTEGER NOT NULL DEFAULT 0,
        qdrant_point_id TEXT,
        qdrant_indexed_at TEXT,
        qdrant_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Copy existing data
      INSERT INTO qdrant_documents_new
      SELECT
        document_id, file_path, source_type, chunk_index, chunk_count, chunk_text,
        span_start, span_end, overlap_tokens, word_count, token_count, content_hash,
        metadata_json, embedding_status, embedding_version, qdrant_point_id,
        qdrant_indexed_at, qdrant_error, created_at, updated_at
      FROM qdrant_documents;

      -- Drop old table and indexes
      DROP INDEX IF EXISTS idx_qdrant_embedding_status;
      DROP INDEX IF EXISTS idx_qdrant_file_source;
      DROP INDEX IF EXISTS idx_qdrant_file_path;
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
    // Restore original constraint (will fail if non-standard source_types exist)
    db.exec(`
      CREATE TABLE qdrant_documents_old (
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
        metadata_json TEXT,
        embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK(embedding_status IN ('pending', 'indexing', 'indexed', 'deleting', 'deleted', 'error')),
        embedding_version INTEGER NOT NULL DEFAULT 0,
        qdrant_point_id TEXT,
        qdrant_indexed_at TEXT,
        qdrant_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO qdrant_documents_old
      SELECT * FROM qdrant_documents
      WHERE source_type IN ('content', 'summary', 'tags');

      DROP INDEX IF EXISTS idx_qdrant_embedding_status;
      DROP INDEX IF EXISTS idx_qdrant_file_source;
      DROP INDEX IF EXISTS idx_qdrant_file_path;
      DROP TABLE qdrant_documents;

      ALTER TABLE qdrant_documents_old RENAME TO qdrant_documents;

      CREATE INDEX idx_qdrant_file_path ON qdrant_documents(file_path);
      CREATE INDEX idx_qdrant_file_source ON qdrant_documents(file_path, source_type);
      CREATE INDEX idx_qdrant_embedding_status ON qdrant_documents(embedding_status)
        WHERE embedding_status != 'indexed';
    `);
  },
};

export default migration;
