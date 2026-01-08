// Ensure inbox table has expected columns (idempotent ALTERs)
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 7,
  description: 'Ensure inbox table includes enriched_at and related columns',

  async up(db: BetterSqlite3.Database) {
    // If table doesn't exist yet, let migration002 create it
    const tableExists = (
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'inbox'"
      ).get() as { name?: string } | undefined
    )?.name === 'inbox';

    if (!tableExists) {
      return; // 002_inbox will run and create the full schema
    }

    const cols = db
      .prepare("PRAGMA table_info('inbox')")
      .all() as Array<{ name: string; type: string }>;
    const has = (name: string) => cols.some((c) => c.name === name);

    // Add missing columns one by one (SQLite supports ADD COLUMN only)
    if (!has('status')) {
      db.exec(
        "ALTER TABLE inbox ADD COLUMN status TEXT DEFAULT 'pending' CHECK(status IN ('pending','enriching','enriched','failed'))"
      );
    }
    if (!has('enriched_at')) {
      db.exec("ALTER TABLE inbox ADD COLUMN enriched_at TEXT");
    }
    if (!has('error')) {
      db.exec("ALTER TABLE inbox ADD COLUMN error TEXT");
    }
    if (!has('ai_slug')) {
      db.exec("ALTER TABLE inbox ADD COLUMN ai_slug TEXT");
    }
    if (!has('schema_version')) {
      db.exec("ALTER TABLE inbox ADD COLUMN schema_version INTEGER DEFAULT 1");
    }
    if (!has('created_at')) {
      db.exec("ALTER TABLE inbox ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'))");
    }
    if (!has('updated_at')) {
      db.exec("ALTER TABLE inbox ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))");
    }
  },

  async down(_db: BetterSqlite3.Database) {
    // No down migration: dropping columns requires table rebuild; keep forward-only
  },
};

export default migration;

