// Add text_preview column to files table for faster inbox rendering
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 29,
  description: 'Add text_preview column to files table',

  async up(db: BetterSqlite3.Database) {
    console.log('[Migration 029] Adding text_preview column to files table');

    // Add text_preview column (nullable - only populated for text files)
    db.exec(`
      ALTER TABLE files ADD COLUMN text_preview TEXT;
    `);

    console.log('[Migration 029] text_preview column added');
  },

  async down(db: BetterSqlite3.Database) {
    console.log('[Migration 029] Removing text_preview column from files table');

    // SQLite doesn't support DROP COLUMN easily, so we'd need to recreate the table
    // For now, just warn that rollback is not supported
    console.warn('[Migration 029] Rollback not supported - would require table recreation');
  },
};

export default migration;
