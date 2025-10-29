// Task queue table for background job processing
import type BetterSqlite3 from 'better-sqlite3';

export default {
  version: 5,
  description: 'Create tasks table for background job processing',

  async up(db: BetterSqlite3.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        -- Identity
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,

        -- Payload (application-defined JSON)
        payload TEXT NOT NULL,

        -- Status
        status TEXT NOT NULL DEFAULT 'to-do'
          CHECK(status IN ('to-do', 'in-progress', 'success', 'failed')),

        -- Optimistic locking
        version INTEGER DEFAULT 0,

        -- Execution tracking
        attempts INTEGER DEFAULT 0,
        last_attempt_at INTEGER,

        -- Results
        result TEXT,
        error TEXT,

        -- Scheduling
        run_after INTEGER,

        -- Timestamps
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      -- Index for fetching ready tasks (FIFO with run_after support)
      CREATE INDEX IF NOT EXISTS idx_tasks_todo
        ON tasks(status, created_at ASC, run_after)
        WHERE status IN ('to-do', 'failed');

      -- Index for task type queries
      CREATE INDEX IF NOT EXISTS idx_tasks_type
        ON tasks(type, status);

      -- Index for chronological listing
      CREATE INDEX IF NOT EXISTS idx_tasks_created
        ON tasks(created_at DESC);
    `);
  },

  async down(db: BetterSqlite3.Database) {
    db.exec(`
      DROP INDEX IF EXISTS idx_tasks_created;
      DROP INDEX IF EXISTS idx_tasks_type;
      DROP INDEX IF EXISTS idx_tasks_todo;
      DROP TABLE IF EXISTS tasks;
    `);
  },
};
