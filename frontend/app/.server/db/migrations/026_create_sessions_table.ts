import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 26,
  description: 'Create sessions table for authentication',

  async up(db: BetterSqlite3.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
    `);
  },

  async down(db: BetterSqlite3.Database) {
    db.exec(`
      DROP TABLE IF EXISTS sessions;
    `);
  },
};

export default migration;
