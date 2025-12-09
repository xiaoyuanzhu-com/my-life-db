import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migration 021: Refactor meili_documents to 1:1 file-to-document mapping
 *
 * This migration simplifies the Meilisearch document structure by:
 * - Removing source_type (no more separate content/summary/tags documents)
 * - Changing to 1:1 mapping where document_id = file_path
 * - Adding separate columns for content, summary, and tags
 * - Keeping all content in a single document per file
 *
 * Benefits:
 * - Simpler mental model (1 file = 1 search result)
 * - No duplicate results in search
 * - Easier to maintain and debug
 * - Same query flexibility via attributesToSearchIn
 */
const migration = {
  version: 21,
  description: 'Refactor meili_documents to 1:1 file-to-document mapping',

  async up(db: BetterSqlite3.Database) {
    // Drop old table and indexes
    db.exec(`
      DROP INDEX IF EXISTS idx_meili_content_type;
      DROP INDEX IF EXISTS idx_meili_status;
      DROP INDEX IF EXISTS idx_meili_file_source;
      DROP INDEX IF EXISTS idx_meili_file_path;
      DROP TABLE IF EXISTS meili_documents;
    `);

    // Create new meili_documents table with 1:1 mapping
    db.exec(`
      CREATE TABLE meili_documents (
        document_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,

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
      CREATE INDEX idx_meili_status
        ON meili_documents(meili_status)
        WHERE meili_status != 'indexed';
    `);

    db.exec(`
      CREATE INDEX idx_meili_mime_type
        ON meili_documents(mime_type);
    `);
  },

  async down(db: BetterSqlite3.Database) {
    // Drop new table and indexes
    db.exec(`
      DROP INDEX IF EXISTS idx_meili_mime_type;
      DROP INDEX IF EXISTS idx_meili_status;
      DROP INDEX IF EXISTS idx_meili_file_path;
      DROP TABLE IF EXISTS meili_documents;
    `);

    // Recreate old meili_documents table (migration 019 schema)
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

      CREATE INDEX idx_meili_file_path
        ON meili_documents(file_path);

      CREATE INDEX idx_meili_file_source
        ON meili_documents(file_path, source_type);

      CREATE INDEX idx_meili_status
        ON meili_documents(meili_status)
        WHERE meili_status != 'indexed';

      CREATE INDEX idx_meili_content_type
        ON meili_documents(content_type);
    `);
  },
};

export default migration;
