import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 25,
  description: 'Add attempts column to digests table',

  async up(db: BetterSqlite3.Database) {
    db.exec(`
      ALTER TABLE digests
      ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    `);
  },

  async down(db: BetterSqlite3.Database) {
    db.exec(`
      CREATE TABLE digests_without_attempts (
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

      INSERT INTO digests_without_attempts (
        id, file_path, digester, status, content, sqlar_name, error, created_at, updated_at
      )
      SELECT
        id,
        file_path,
        digester,
        status,
        content,
        sqlar_name,
        error,
        created_at,
        updated_at
      FROM digests;

      DROP INDEX IF EXISTS idx_digests_file_path;
      DROP INDEX IF EXISTS idx_digests_digester;
      DROP INDEX IF EXISTS idx_digests_status;
      DROP TABLE digests;

      ALTER TABLE digests_without_attempts RENAME TO digests;

      CREATE INDEX idx_digests_file_path ON digests(file_path);
      CREATE INDEX idx_digests_digester ON digests(digester);
      CREATE INDEX idx_digests_status ON digests(status);
    `);
  },
};

export default migration;
