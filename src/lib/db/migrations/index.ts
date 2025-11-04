// Migration registry
import type BetterSqlite3 from 'better-sqlite3';
import migration001 from './001_initial';
import migration002 from './002_inbox';
import migration003 from './003_library';
import migration004 from './004_schemas';
import migration005 from './005_tasks';
import migration006 from './006_inbox_task_state';
import migration007 from './007_inbox_fix_schema';
import migration008 from './008_tasks_rename_columns';
import migration009 from './009_tasks_rebuild_input_output';
import migration010 from './010_tasks_force_ensure_input_output';
import migration011 from './011_rename_process_url_to_digest';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'DBMigrations' });

export interface Migration {
  version: number;
  description: string;
  up: (db: BetterSqlite3.Database) => Promise<void> | void;
  down: (db: BetterSqlite3.Database) => Promise<void> | void;
}

// Export all migrations in order
export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
];

/**
 * Run pending migrations
 */
export async function runMigrations(db: BetterSqlite3.Database): Promise<void> {
  // Ensure schema_version table exists (bootstrap)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP,
      description TEXT
    );
  `);

  // Get current version
  const currentVersionRow = db
    .prepare('SELECT MAX(version) as version FROM schema_version')
    .get() as { version: number | null };

  const currentVersion = currentVersionRow?.version || 0;

  // Find pending migrations
  const pendingMigrations = migrations.filter((m) => m.version > currentVersion);

  if (pendingMigrations.length === 0) {
    log.info({ currentVersion }, 'migrations up to date');
    return;
  }

  log.info({ count: pendingMigrations.length, from: currentVersion, to: migrations[migrations.length - 1].version }, 'running pending migrations');

  // Run each migration in a transaction
  for (const migration of pendingMigrations) {
    const transaction = db.transaction(() => {
      log.info({ version: migration.version, description: migration.description }, 'applying migration');

      // Run migration
      migration.up(db);

      // Record in schema_version
      db.prepare(
        'INSERT INTO schema_version (version, description) VALUES (?, ?)'
      ).run(migration.version, migration.description);

      log.info({ version: migration.version }, 'migration applied');
    });

    transaction();
  }

  log.info({}, 'all migrations completed');
}

/**
 * Get current schema version
 */
export function getCurrentSchemaVersion(db: BetterSqlite3.Database): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as version FROM schema_version')
      .get() as { version: number | null };
    return row?.version || 0;
  } catch {
    return 0;
  }
}

/**
 * Rollback last migration (for development only)
 */
export async function rollbackLastMigration(db: BetterSqlite3.Database): Promise<void> {
  const currentVersion = getCurrentSchemaVersion(db);

  if (currentVersion === 0) {
    log.info({}, 'no migrations to rollback');
    return;
  }

  const migration = migrations.find((m) => m.version === currentVersion);

  if (!migration) {
    throw new Error(`Migration v${currentVersion} not found`);
  }

  log.info({ version: migration.version, description: migration.description }, 'rolling back migration');

  const transaction = db.transaction(() => {
    // Run down migration
    migration.down(db);

    // Remove from schema_version
    db.prepare('DELETE FROM schema_version WHERE version = ?').run(currentVersion);

    log.info({ version: migration.version }, 'migration rolled back');
  });

  transaction();
}
