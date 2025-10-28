// Library table for file indexing
import type BetterSqlite3 from 'better-sqlite3';

export default {
  version: 3,
  description: 'Create library table for file system indexing',

  async up(db: BetterSqlite3.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS library (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        is_folder INTEGER NOT NULL,
        file_size INTEGER,
        modified_at TEXT NOT NULL,
        content_hash TEXT,
        content_type TEXT,
        searchable_text TEXT,
        enrichment TEXT,
        schema_version INTEGER DEFAULT 1,
        indexed_at TEXT DEFAULT CURRENT_TIMESTAMP,
        enriched_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_library_path_prefix ON library(path);
      CREATE INDEX IF NOT EXISTS idx_library_modified ON library(modified_at);
      CREATE INDEX IF NOT EXISTS idx_library_content_type ON library(content_type);
      CREATE INDEX IF NOT EXISTS idx_library_schema_version ON library(schema_version);
    `);
  },

  async down(db: BetterSqlite3.Database) {
    db.exec(`
      DROP INDEX IF EXISTS idx_library_schema_version;
      DROP INDEX IF EXISTS idx_library_content_type;
      DROP INDEX IF EXISTS idx_library_modified;
      DROP INDEX IF EXISTS idx_library_path_prefix;
      DROP TABLE IF EXISTS library;
    `);
  },
};
