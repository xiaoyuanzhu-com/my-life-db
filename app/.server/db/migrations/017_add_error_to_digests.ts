// Add error column to digests table for storing task failure messages
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 17,
  description: 'Add error column to digests table',

  async up(db: BetterSqlite3.Database) {
    db.exec(`
      ALTER TABLE digests ADD COLUMN error TEXT;
    `);
  },

  async down(db: BetterSqlite3.Database) {
    // SQLite doesn't support DROP COLUMN easily, so we recreate the table
    db.exec(`
      CREATE TABLE digests_backup (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        digest_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        content TEXT,
        sqlar_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      );

      INSERT INTO digests_backup SELECT
        id, item_id, digest_type, status, content, sqlar_name, created_at, updated_at
      FROM digests;

      DROP TABLE digests;
      ALTER TABLE digests_backup RENAME TO digests;

      CREATE INDEX idx_digests_item_id ON digests(item_id);
      CREATE INDEX idx_digests_type ON digests(digest_type);
      CREATE INDEX idx_digests_status ON digests(status);
    `);
  },
};

export default migration;
