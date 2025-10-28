// Migration registry
import type BetterSqlite3 from 'better-sqlite3';
import migration001 from './001_initial';
import migration002 from './002_inbox';
import migration003 from './003_library';
import migration004 from './004_schemas';

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
    console.log(`[DB] All migrations up to date (v${currentVersion})`);
    return;
  }

  console.log(
    `[DB] Running ${pendingMigrations.length} pending migration(s) from v${currentVersion} to v${migrations[migrations.length - 1].version}`
  );

  // Run each migration in a transaction
  for (const migration of pendingMigrations) {
    const transaction = db.transaction(() => {
      console.log(`[DB] Applying migration ${migration.version}: ${migration.description}`);

      // Run migration
      migration.up(db);

      // Record in schema_version
      db.prepare(
        'INSERT INTO schema_version (version, description) VALUES (?, ?)'
      ).run(migration.version, migration.description);

      console.log(`[DB] ✓ Migration ${migration.version} applied successfully`);
    });

    transaction();
  }

  console.log(`[DB] All migrations completed successfully`);
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
    console.log('[DB] No migrations to rollback');
    return;
  }

  const migration = migrations.find((m) => m.version === currentVersion);

  if (!migration) {
    throw new Error(`Migration v${currentVersion} not found`);
  }

  console.log(`[DB] Rolling back migration ${migration.version}: ${migration.description}`);

  const transaction = db.transaction(() => {
    // Run down migration
    migration.down(db);

    // Remove from schema_version
    db.prepare('DELETE FROM schema_version WHERE version = ?').run(currentVersion);

    console.log(`[DB] ✓ Migration ${migration.version} rolled back successfully`);
  });

  transaction();
}
