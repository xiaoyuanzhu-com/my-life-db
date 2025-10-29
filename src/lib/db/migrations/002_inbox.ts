// Inbox table for temporary staging
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 2,
  description: 'Create inbox table for temporary staging',

  async up(db: BetterSqlite3.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY,
        folder_name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('text', 'url', 'image', 'audio', 'video', 'pdf', 'mixed')),
        files TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
        processed_at TEXT,
        error TEXT,
        ai_slug TEXT,
        schema_version INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_inbox_created_at ON inbox(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status);
      CREATE INDEX IF NOT EXISTS idx_inbox_folder_name ON inbox(folder_name);
      CREATE INDEX IF NOT EXISTS idx_inbox_schema_version ON inbox(schema_version);
    `);
  },

  async down(db: BetterSqlite3.Database) {
    db.exec(`
      DROP INDEX IF EXISTS idx_inbox_schema_version;
      DROP INDEX IF EXISTS idx_inbox_folder_name;
      DROP INDEX IF EXISTS idx_inbox_status;
      DROP INDEX IF EXISTS idx_inbox_created_at;
      DROP TABLE IF EXISTS inbox;
    `);
  },
};

export default migration;
