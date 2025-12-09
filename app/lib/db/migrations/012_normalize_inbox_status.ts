import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 12,
  description: 'Normalize inbox status values to pending/enriching/enriched/failed',

  async up(db: BetterSqlite3.Database) {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox'")
      .get() as { name?: string } | undefined;

    if (!tableExists) {
      return;
    }

    db.exec('PRAGMA foreign_keys = OFF;');

    db.exec(`
      CREATE TABLE inbox_new (
        id TEXT PRIMARY KEY,
        folder_name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('text', 'url', 'image', 'audio', 'video', 'pdf', 'mixed')),
        files TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'enriching', 'enriched', 'failed')),
        enriched_at TEXT,
        error TEXT,
        ai_slug TEXT,
        schema_version INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    db.exec(`
      INSERT INTO inbox_new (
        id, folder_name, type, files, status, enriched_at,
        error, ai_slug, schema_version, created_at, updated_at
      )
      SELECT
        id,
        folder_name,
        type,
        files,
        CASE status
          WHEN 'processing' THEN 'enriching'
          WHEN 'completed' THEN 'enriched'
          ELSE status
        END AS status,
        enriched_at,
        error,
        ai_slug,
        schema_version,
        created_at,
        updated_at
      FROM inbox;
    `);

    db.exec(`
      DROP TABLE inbox;
      ALTER TABLE inbox_new RENAME TO inbox;
      CREATE INDEX IF NOT EXISTS idx_inbox_created_at ON inbox(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status);
      CREATE INDEX IF NOT EXISTS idx_inbox_folder_name ON inbox(folder_name);
      CREATE INDEX IF NOT EXISTS idx_inbox_schema_version ON inbox(schema_version);
    `);

    db.exec('PRAGMA foreign_keys = ON;');
  },

  async down(db: BetterSqlite3.Database) {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox'")
      .get() as { name?: string } | undefined;

    if (!tableExists) {
      return;
    }

    db.exec('PRAGMA foreign_keys = OFF;');

    db.exec(`
      CREATE TABLE inbox_old (
        id TEXT PRIMARY KEY,
        folder_name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('text', 'url', 'image', 'audio', 'video', 'pdf', 'mixed')),
        files TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
        enriched_at TEXT,
        error TEXT,
        ai_slug TEXT,
        schema_version INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    db.exec(`
      INSERT INTO inbox_old (
        id, folder_name, type, files, status, enriched_at,
        error, ai_slug, schema_version, created_at, updated_at
      )
      SELECT
        id,
        folder_name,
        type,
        files,
        CASE status
          WHEN 'enriching' THEN 'processing'
          WHEN 'enriched' THEN 'completed'
          ELSE status
        END AS status,
        enriched_at,
        error,
        ai_slug,
        schema_version,
        created_at,
        updated_at
      FROM inbox;
    `);

    db.exec(`
      DROP TABLE inbox;
      ALTER TABLE inbox_old RENAME TO inbox;
      CREATE INDEX IF NOT EXISTS idx_inbox_created_at ON inbox(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status);
      CREATE INDEX IF NOT EXISTS idx_inbox_folder_name ON inbox(folder_name);
      CREATE INDEX IF NOT EXISTS idx_inbox_schema_version ON inbox(schema_version);
    `);

    db.exec('PRAGMA foreign_keys = ON;');
  },
};

export default migration;

