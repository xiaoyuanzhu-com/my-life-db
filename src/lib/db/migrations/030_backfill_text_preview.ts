// Backfill text_preview for existing text files
import type BetterSqlite3 from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';

const migration = {
  version: 30,
  description: 'Backfill text_preview for existing text files',

  async up(db: BetterSqlite3.Database) {
    console.log('[Migration 030] Backfilling text_preview for existing text files');

    // Get DATA_ROOT from environment
    const DATA_ROOT = process.env.MY_DATA_DIR || path.join(process.cwd(), 'data');

    // Find all text files without text_preview
    const textFiles = db.prepare(`
      SELECT path, mime_type
      FROM files
      WHERE mime_type LIKE 'text/%'
        AND is_folder = 0
        AND text_preview IS NULL
    `).all() as Array<{ path: string; mime_type: string }>;

    console.log(`[Migration 030] Found ${textFiles.length} text files to backfill`);

    let updated = 0;
    let errors = 0;

    // Update each file with text preview
    for (const file of textFiles) {
      try {
        const fullPath = path.join(DATA_ROOT, file.path);
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n').slice(0, 50);
        const textPreview = lines.join('\n');

        db.prepare('UPDATE files SET text_preview = ? WHERE path = ?').run(
          textPreview,
          file.path
        );

        updated++;
      } catch (error) {
        // File might be deleted or unreadable, skip it
        errors++;
      }
    }

    console.log(`[Migration 030] Backfilled ${updated} text files (${errors} errors)`);
  },

  async down(db: BetterSqlite3.Database) {
    console.log('[Migration 030] Clearing backfilled text_preview');

    db.exec(`
      UPDATE files SET text_preview = NULL WHERE mime_type LIKE 'text/%';
    `);

    console.log('[Migration 030] text_preview cleared');
  },
};

export default migration;
