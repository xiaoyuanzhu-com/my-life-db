import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migration 019: Create meili_documents table for Meilisearch
 *
 * This migration removes the old search_documents table (which mixed
 * Meilisearch and Qdrant concerns) and creates a dedicated meili_documents
 * table optimized for full-text keyword search.
 *
 * Key changes:
 * - Drop old search_documents table (entry_id/library_id are obsolete)
 * - Create meili_documents table with file_path as reference
 * - Store full text (no chunking) for better BM25 ranking
 * - Independent status tracking (meili_status only)
 */
const migration = {
  version: 19,
  description: 'Create meili_documents table for Meilisearch full-text search',

  async up(db: BetterSqlite3.Database) {
    // Drop old search_documents table and all related indexes
    db.exec(`
      DROP INDEX IF EXISTS idx_search_documents_entry_variant;
      DROP INDEX IF EXISTS idx_search_documents_meili_status;
      DROP INDEX IF EXISTS idx_search_documents_embedding_status;
      DROP INDEX IF EXISTS idx_search_documents_content_type;
      DROP TABLE IF EXISTS search_documents;
    `);

    // Create new meili_documents table (full text, no chunking)
    db.exec(`
      CREATE TABLE meili_documents (
        document_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('content', 'summary', 'tags')),

        -- Full text content (no chunking)
        full_text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        word_count INTEGER NOT NULL,

        -- Metadata
        content_type TEXT NOT NULL CHECK(content_type IN ('url', 'text', 'pdf', 'image', 'audio', 'video', 'mixed')),
        metadata_json TEXT,

        -- Meilisearch sync status
        meili_status TEXT NOT NULL DEFAULT 'pending' CHECK(meili_status IN ('pending', 'indexing', 'indexed', 'deleting', 'deleted', 'error')),
        meili_task_id TEXT,
        meili_indexed_at TEXT,
        meili_error TEXT,

        -- Timestamps
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Create indexes for efficient queries
    db.exec(`
      CREATE INDEX idx_meili_file_path
        ON meili_documents(file_path);
    `);

    db.exec(`
      CREATE INDEX idx_meili_file_source
        ON meili_documents(file_path, source_type);
    `);

    db.exec(`
      CREATE INDEX idx_meili_status
        ON meili_documents(meili_status)
        WHERE meili_status != 'indexed';
    `);

    db.exec(`
      CREATE INDEX idx_meili_content_type
        ON meili_documents(content_type);
    `);
  },

  async down(db: BetterSqlite3.Database) {
    // Drop meili_documents table and indexes
    db.exec(`
      DROP INDEX IF EXISTS idx_meili_content_type;
      DROP INDEX IF EXISTS idx_meili_status;
      DROP INDEX IF EXISTS idx_meili_file_source;
      DROP INDEX IF EXISTS idx_meili_file_path;
      DROP TABLE IF EXISTS meili_documents;
    `);

    // Recreate old search_documents table (for rollback compatibility)
    db.exec(`
      CREATE TABLE search_documents (
        document_id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        library_id TEXT,
        source_url TEXT,
        source_path TEXT NOT NULL,
        variant TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        span_start INTEGER NOT NULL,
        span_end INTEGER NOT NULL,
        overlap_tokens INTEGER NOT NULL,
        word_count INTEGER NOT NULL,
        token_count INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        metadata_json TEXT,
        content_type TEXT NOT NULL DEFAULT 'url' CHECK(content_type IN ('text', 'url', 'image', 'audio', 'video', 'pdf', 'mixed')),
        meili_status TEXT NOT NULL DEFAULT 'pending' CHECK(meili_status IN ('pending','indexing','indexed','deleting','deleted','error')),
        meili_task_id TEXT,
        last_indexed_at TEXT,
        last_deindexed_at TEXT,
        embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK(embedding_status IN ('pending','indexing','indexed','deleting','deleted','error')),
        embedding_version INTEGER NOT NULL DEFAULT 0,
        last_embedded_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX idx_search_documents_entry_variant
        ON search_documents(entry_id, variant);
      CREATE INDEX idx_search_documents_meili_status
        ON search_documents(meili_status) WHERE meili_status != 'indexed';
      CREATE INDEX idx_search_documents_embedding_status
        ON search_documents(embedding_status) WHERE embedding_status != 'indexed';
      CREATE INDEX idx_search_documents_content_type
        ON search_documents(content_type);
    `);
  },
};

export default migration;
