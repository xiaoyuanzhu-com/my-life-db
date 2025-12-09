// Add screenshot_sqlar column to files table for faster inbox rendering
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 35,
  description: 'Add screenshot_sqlar column to files table',

  async up(db: BetterSqlite3.Database) {
    console.log('[Migration 035] Adding screenshot_sqlar column to files table');

    // Add screenshot_sqlar column (nullable - only populated for files with screenshot digests)
    db.exec(`
      ALTER TABLE files ADD COLUMN screenshot_sqlar TEXT;
    `);

    // Backfill from existing digests
    console.log('[Migration 035] Backfilling screenshot_sqlar from digests table');

    const result = db.prepare(`
      UPDATE files
      SET screenshot_sqlar = (
        SELECT d.sqlar_name
        FROM digests d
        WHERE d.file_path = files.path
          AND d.digester IN ('doc-to-screenshot', 'url-crawl-screenshot')
          AND d.status = 'completed'
          AND d.sqlar_name IS NOT NULL
        ORDER BY
          CASE d.digester
            WHEN 'doc-to-screenshot' THEN 1
            WHEN 'url-crawl-screenshot' THEN 2
          END
        LIMIT 1
      )
      WHERE EXISTS (
        SELECT 1 FROM digests d
        WHERE d.file_path = files.path
          AND d.digester IN ('doc-to-screenshot', 'url-crawl-screenshot')
          AND d.status = 'completed'
          AND d.sqlar_name IS NOT NULL
      )
    `).run();

    console.log(`[Migration 035] Backfilled ${result.changes} files with screenshot_sqlar`);
  },

  async down(db: BetterSqlite3.Database) {
    console.log('[Migration 035] Removing screenshot_sqlar column from files table');
    console.warn('[Migration 035] Rollback not supported - would require table recreation');
  },
};

export default migration;
