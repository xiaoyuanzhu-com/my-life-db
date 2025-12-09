// Rename digest_type column to digester
// Also update status values: pending→todo, enriching→in-progress, enriched→completed
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 24,
  description: 'Rename digest_type to digester and update status values',

  async up(db: BetterSqlite3.Database) {
    console.log('[Migration 024] Renaming digest_type to digester and updating status values');

    // SQLite doesn't support ALTER COLUMN, so we need to:
    // 1. Create new table with updated schema
    // 2. Copy data with status mapping
    // 3. Drop old table
    // 4. Rename new table

    db.exec(`
      -- Create new digests table with updated schema
      CREATE TABLE digests_new (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        digester TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo',
        content TEXT,
        sqlar_name TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Copy data with status value mapping
      INSERT INTO digests_new (id, file_path, digester, status, content, sqlar_name, error, created_at, updated_at)
      SELECT
        id,
        file_path,
        digest_type,
        CASE status
          WHEN 'pending' THEN 'todo'
          WHEN 'enriching' THEN 'in-progress'
          WHEN 'enriched' THEN 'completed'
          ELSE status  -- Keep 'failed' and 'skipped' as-is
        END,
        content,
        sqlar_name,
        error,
        created_at,
        updated_at
      FROM digests;

      -- Drop old table and indexes
      DROP INDEX IF EXISTS idx_digests_file_path;
      DROP INDEX IF EXISTS idx_digests_type;
      DROP INDEX IF EXISTS idx_digests_status;
      DROP TABLE digests;

      -- Rename new table to digests
      ALTER TABLE digests_new RENAME TO digests;

      -- Recreate indexes with updated column name
      CREATE INDEX idx_digests_file_path ON digests(file_path);
      CREATE INDEX idx_digests_digester ON digests(digester);
      CREATE INDEX idx_digests_status ON digests(status);
    `);

    console.log('[Migration 024] Successfully renamed digest_type to digester');
  },

  async down(db: BetterSqlite3.Database) {
    console.log('[Migration 024] Reverting digester to digest_type and status values');

    db.exec(`
      -- Create old digests table
      CREATE TABLE digests_old (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        digest_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        content TEXT,
        sqlar_name TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Copy data with reverse status mapping
      INSERT INTO digests_old (id, file_path, digest_type, status, content, sqlar_name, error, created_at, updated_at)
      SELECT
        id,
        file_path,
        digester,
        CASE status
          WHEN 'todo' THEN 'pending'
          WHEN 'in-progress' THEN 'enriching'
          WHEN 'completed' THEN 'enriched'
          ELSE status  -- Keep 'failed' and 'skipped' as-is
        END,
        content,
        sqlar_name,
        error,
        created_at,
        updated_at
      FROM digests;

      -- Drop new table and indexes
      DROP INDEX IF EXISTS idx_digests_file_path;
      DROP INDEX IF EXISTS idx_digests_digester;
      DROP INDEX IF EXISTS idx_digests_status;
      DROP TABLE digests;

      -- Rename old table back
      ALTER TABLE digests_old RENAME TO digests;

      -- Recreate old indexes
      CREATE INDEX idx_digests_file_path ON digests(file_path);
      CREATE INDEX idx_digests_type ON digests(digest_type);
      CREATE INDEX idx_digests_status ON digests(status);
    `);

    console.log('[Migration 024] Successfully reverted to digest_type');
  },
};

export default migration;
