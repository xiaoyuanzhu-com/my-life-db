// Add composite indexes for optimized inbox queries
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 28,
  description: 'Add composite indexes for inbox performance',

  async up(db: BetterSqlite3.Database) {
    console.log('[Migration 028] Adding composite indexes');

    // Composite index for digests lookup by (file_path, digester)
    // This optimizes the common pattern: WHERE file_path = ? AND digester = ?
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_digests_file_path_digester
      ON digests(file_path, digester);
    `);

    // Composite index for files ordered by created_at with path prefix
    // This optimizes: WHERE path LIKE 'inbox/%' ORDER BY created_at DESC
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_files_path_created_at
      ON files(path, created_at DESC);
    `);

    console.log('[Migration 028] Composite indexes created');
  },

  async down(db: BetterSqlite3.Database) {
    console.log('[Migration 028] Removing composite indexes');

    db.exec(`
      DROP INDEX IF EXISTS idx_digests_file_path_digester;
      DROP INDEX IF EXISTS idx_files_path_created_at;
    `);

    console.log('[Migration 028] Composite indexes removed');
  },
};

export default migration;
