// Add 'skipped' status to digests for digesters that don't apply to a file
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 23,
  description: 'Add skipped status to digests table',

  async up(db: BetterSqlite3.Database) {
    // Note: SQLite doesn't support ALTER TYPE for enums
    // Status is stored as TEXT, so 'skipped' can be used immediately
    // No schema changes needed - just update type definitions

    // This migration is a no-op for the database
    // The actual change is in the TypeScript type definition
    console.log('[Migration 023] Adding skipped status support (type-level only)');
  },

  async down(db: BetterSqlite3.Database) {
    // Update any 'skipped' statuses back to 'pending'
    db.exec(`
      UPDATE digests
      SET status = 'pending',
          error = 'Reverted from skipped status'
      WHERE status = 'skipped';
    `);

    console.log('[Migration 023] Reverted skipped statuses to pending');
  },
};

export default migration;
