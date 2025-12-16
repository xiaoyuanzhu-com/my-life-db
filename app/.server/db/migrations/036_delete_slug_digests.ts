// Delete orphaned slug digests (digester no longer exists)
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 36,
  description: 'Delete orphaned slug digests',

  async up(db: BetterSqlite3.Database) {
    console.log('[Migration 036] Deleting orphaned slug digests');

    const result = db.prepare(`
      DELETE FROM digests WHERE digester = 'slug'
    `).run();

    console.log(`[Migration 036] Deleted ${result.changes} slug digests`);
  },

  async down(_db: BetterSqlite3.Database) {
    console.log('[Migration 036] Rollback not supported - slug digests cannot be restored');
  },
};

export default migration;
