import type BetterSqlite3 from 'better-sqlite3';
import type { Migration } from './index';

const migration: Migration = {
  version: 34,
  description: 'Create processing_locks table for digest coordination',
  up: (db: BetterSqlite3.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS processing_locks (
        file_path TEXT PRIMARY KEY,
        locked_at TEXT NOT NULL,
        locked_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_processing_locks_locked_at
        ON processing_locks(locked_at);
    `);
  },
  down: (db: BetterSqlite3.Database) => {
    db.exec(`DROP TABLE IF EXISTS processing_locks`);
  },
};

export default migration;
