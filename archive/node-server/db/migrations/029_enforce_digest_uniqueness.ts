// Enforce uniqueness for digests per (file_path, digester)
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 29,
  description: 'Enforce unique digests per file_path+digester',

  async up(db: BetterSqlite3.Database) {
    console.log('[Migration 029] Enforcing unique digests per file_path+digester');

    // Remove duplicate rows, keep the earliest rowid per (file_path, digester)
    db.exec(`
      DELETE FROM digests
      WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM digests GROUP BY file_path, digester
      );
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_digests_file_path_digester_unique
      ON digests(file_path, digester);
    `);
  },

  async down(db: BetterSqlite3.Database) {
    console.log('[Migration 029] Dropping unique index for digests');
    db.exec(`DROP INDEX IF EXISTS idx_digests_file_path_digester_unique;`);
  },
};

export default migration;
