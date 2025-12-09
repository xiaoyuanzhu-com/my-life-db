// Rename tasks table columns: payload -> input, result -> output
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 8,
  description: 'Rename tasks columns payload->input and result->output',

  async up(db: BetterSqlite3.Database) {
    // SQLite 3.25.0+ supports RENAME COLUMN
    db.exec(`
      PRAGMA foreign_keys=OFF;
      ALTER TABLE tasks RENAME COLUMN payload TO input;
      ALTER TABLE tasks RENAME COLUMN result TO output;
      PRAGMA foreign_keys=ON;
    `);
  },

  async down(db: BetterSqlite3.Database) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      ALTER TABLE tasks RENAME COLUMN input TO payload;
      ALTER TABLE tasks RENAME COLUMN output TO result;
      PRAGMA foreign_keys=ON;
    `);
  },
};

export default migration;

