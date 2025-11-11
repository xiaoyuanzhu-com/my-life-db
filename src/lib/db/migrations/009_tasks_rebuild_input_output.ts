// Rebuild tasks table to ensure input/output columns exist
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 9,
  description: 'Rebuild tasks table with input/output columns (migrate from payload/result if needed)',

  async up(db: BetterSqlite3.Database) {
    const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
    const hasInput = cols.some((c) => c.name === 'input');
    const hasPayload = cols.some((c) => c.name === 'payload');

    if (hasInput) {
      // Already migrated; nothing to do
      return;
    }

    if (!hasPayload) {
      // Unexpected schema; skip to avoid destructive changes
      return;
    }

    db.exec(`
      PRAGMA foreign_keys = OFF;
      -- Create new table with desired schema
      CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'to-do'
          CHECK(status IN ('to-do', 'in-progress', 'success', 'failed')),
        version INTEGER DEFAULT 0,
        attempts INTEGER DEFAULT 0,
        last_attempt_at INTEGER,
        output TEXT,
        error TEXT,
        run_after INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      -- Copy data mapping payload->input and result->output
      INSERT INTO tasks_new (
        id, type, input, status, version, attempts, last_attempt_at,
        output, error, run_after, created_at, updated_at, completed_at
      )
      SELECT
        id, type, payload, status, version, attempts, last_attempt_at,
        result, error, run_after, created_at, updated_at, completed_at
      FROM tasks;

      -- Replace old table
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;

      -- Recreate indexes
      CREATE INDEX IF NOT EXISTS idx_tasks_todo
        ON tasks(status, created_at ASC, run_after)
        WHERE status IN ('to-do', 'failed');
      CREATE INDEX IF NOT EXISTS idx_tasks_type
        ON tasks(type, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created
        ON tasks(created_at DESC);

      PRAGMA foreign_keys = ON;
    `);
  },

  async down(db: BetterSqlite3.Database) {
    const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
    const hasPayload = cols.some((c) => c.name === 'payload');
    if (hasPayload) return; // already in old format

    // Rebuild back to payload/result if needed
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE tasks_old (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'to-do'
          CHECK(status IN ('to-do', 'in-progress', 'success', 'failed')),
        version INTEGER DEFAULT 0,
        attempts INTEGER DEFAULT 0,
        last_attempt_at INTEGER,
        result TEXT,
        error TEXT,
        run_after INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      INSERT INTO tasks_old (
        id, type, payload, status, version, attempts, last_attempt_at,
        result, error, run_after, created_at, updated_at, completed_at
      )
      SELECT
        id, type, input, status, version, attempts, last_attempt_at,
        output, error, run_after, created_at, updated_at, completed_at
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_old RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_todo
        ON tasks(status, created_at ASC, run_after)
        WHERE status IN ('to-do', 'failed');
      CREATE INDEX IF NOT EXISTS idx_tasks_type
        ON tasks(type, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created
        ON tasks(created_at DESC);
      PRAGMA foreign_keys = ON;
    `);
  },
};

export default migration;

