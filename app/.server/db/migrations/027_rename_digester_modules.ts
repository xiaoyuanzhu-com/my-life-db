// Rename digester modules:
// - tagging → tags
// - search-meili → search-keyword
// - search-qdrant → search-semantic
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 27,
  description: 'Rename digester modules for clarity',

  async up(db: BetterSqlite3.Database) {
    console.log('[Migration 027] Renaming digester modules');

    // Update digester names in digests table
    db.exec(`
      UPDATE digests SET digester = 'tags' WHERE digester = 'tagging';
      UPDATE digests SET digester = 'search-keyword' WHERE digester = 'search-meili';
      UPDATE digests SET digester = 'search-semantic' WHERE digester = 'search-qdrant';
    `);

    const changes = db.prepare('SELECT changes()').get() as { 'changes()': number };
    console.log(`[Migration 027] Updated ${changes['changes()']} digest records`);
  },

  async down(db: BetterSqlite3.Database) {
    console.log('[Migration 027] Reverting digester module names');

    // Revert digester names in digests table
    db.exec(`
      UPDATE digests SET digester = 'tagging' WHERE digester = 'tags';
      UPDATE digests SET digester = 'search-meili' WHERE digester = 'search-keyword';
      UPDATE digests SET digester = 'search-qdrant' WHERE digester = 'search-semantic';
    `);

    const changes = db.prepare('SELECT changes()').get() as { 'changes()': number };
    console.log(`[Migration 027] Reverted ${changes['changes()']} digest records`);
  },
};

export default migration;
