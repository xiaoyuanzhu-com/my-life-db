// Projection table for fast inbox task status lookup
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 6,
  description: 'Create inbox_task_state projection table',

  async up(db: BetterSqlite3.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_task_state (
        inbox_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('to-do', 'in-progress', 'success', 'failed')),
        task_id TEXT,
        attempts INTEGER DEFAULT 0,
        error TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (inbox_id, task_type)
      );

      CREATE INDEX IF NOT EXISTS idx_inbox_task_state_inbox ON inbox_task_state(inbox_id);
      CREATE INDEX IF NOT EXISTS idx_inbox_task_state_inbox_status ON inbox_task_state(inbox_id, status);
    `);
  },

  async down(db: BetterSqlite3.Database) {
    db.exec(`
      DROP INDEX IF EXISTS idx_inbox_task_state_inbox_status;
      DROP INDEX IF EXISTS idx_inbox_task_state_inbox;
      DROP TABLE IF EXISTS inbox_task_state;
    `);
  },
};

export default migration;

