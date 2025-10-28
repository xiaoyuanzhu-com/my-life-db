// Initial migration: Settings table
import type BetterSqlite3 from 'better-sqlite3';

export default {
  version: 1,
  description: 'Initial schema with settings table',

  async up(db: BetterSqlite3.Database) {
    // Settings table with key-value structure
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create trigger to update updated_at timestamp
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS settings_updated_at
      AFTER UPDATE ON settings
      BEGIN
        UPDATE settings SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
      END;
    `);
  },

  async down(db: BetterSqlite3.Database) {
    db.exec(`DROP TRIGGER IF EXISTS settings_updated_at;`);
    db.exec(`DROP TABLE IF EXISTS settings;`);
  },
};
