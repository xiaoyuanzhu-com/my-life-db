import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 31,
  description: 'Create pins table for pinned items',

  async up(db: BetterSqlite3.Database) {
    db.exec(`
      CREATE TABLE pins (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        pinned_at TEXT NOT NULL,
        display_text TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
      );

      CREATE INDEX idx_pins_file_path ON pins(file_path);
      CREATE INDEX idx_pins_pinned_at ON pins(pinned_at DESC);
    `);
  },

  async down(db: BetterSqlite3.Database) {
    db.exec('DROP TABLE IF EXISTS pins;');
  },
};

export default migration;
