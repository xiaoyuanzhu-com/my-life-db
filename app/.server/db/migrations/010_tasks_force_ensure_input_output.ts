// Force-ensure tasks table has input/output columns by rebuilding from whatever exists
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 10,
  description: 'Force ensure tasks.input/output columns by rebuilding table if missing',

  async up(db: BetterSqlite3.Database) {
    const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));

    const hasInput = names.has('input');
    const hasOutput = names.has('output');
    const hasPayload = names.has('payload');
    const hasResult = names.has('result');

    if (hasInput && hasOutput) {
      // Already in desired state
      return;
    }

    // Choose source columns for copy without referencing non-existent columns
    const srcInputCol = hasPayload ? 'payload' : (hasInput ? 'input' : null);
    const srcOutputCol = hasResult ? 'result' : (hasOutput ? 'output' : null);

    // Build copy SQL safely
    const selectColumns = [
      'id',
      'type',
      srcInputCol ? srcInputCol : "'' AS input_fallback",
      'status',
      'version',
      'attempts',
      'last_attempt_at',
      srcOutputCol ? srcOutputCol : 'NULL AS output_fallback',
      'error',
      'run_after',
      'created_at',
      'updated_at',
      'completed_at',
    ];

    const selectSQL = `SELECT ${selectColumns.join(', ')} FROM tasks`;

    // Rebuild under outer transaction (runner wraps this)
    db.exec(`PRAGMA foreign_keys=OFF;`);

    db.exec(`
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
    `);

    // Copy rows
    const insertSQL = `
      INSERT INTO tasks_new (
        id, type, input, status, version, attempts, last_attempt_at,
        output, error, run_after, created_at, updated_at, completed_at
      ) ${selectSQL};
    `;
    db.prepare(insertSQL).run();

    // Replace old table and indexes
    db.exec(`
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_todo
        ON tasks(status, created_at ASC, run_after)
        WHERE status IN ('to-do', 'failed');
      CREATE INDEX IF NOT EXISTS idx_tasks_type
        ON tasks(type, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created
        ON tasks(created_at DESC);
    `);

    db.exec(`PRAGMA foreign_keys=ON;`);
  },

  async down(_db: BetterSqlite3.Database) {
    // No-op: we intentionally keep the canonical schema
  },
};

export default migration;

