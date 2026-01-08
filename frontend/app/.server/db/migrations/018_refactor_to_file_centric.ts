// Major refactor: Remove items abstraction, use file-centric architecture
// - Drop items table (no longer needed)
// - Drop inbox_task_state table (status tracked in digests)
// - Create files table (rebuildable file metadata cache)
// - Update digests table to reference file paths instead of item IDs
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 18,
  description: 'Refactor to file-centric architecture',

  async up(db: BetterSqlite3.Database) {
    // Drop inbox_task_state table (status now in digests)
    db.exec(`
      DROP INDEX IF EXISTS idx_inbox_task_state_status;
      DROP INDEX IF EXISTS idx_inbox_task_state_item_id;
      DROP TABLE IF EXISTS inbox_task_state;
    `);

    // Recreate digests table with file_path instead of item_id
    db.exec(`
      -- Backup old digests (we won't migrate data - rebuild from scratch)
      DROP TABLE IF EXISTS digests_old;
      ALTER TABLE digests RENAME TO digests_old;
      DROP INDEX IF EXISTS idx_digests_item_id;
      DROP INDEX IF EXISTS idx_digests_type;
      DROP INDEX IF EXISTS idx_digests_status;

      -- Create new digests table
      CREATE TABLE digests (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        digest_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        content TEXT,
        sqlar_name TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_digests_file_path ON digests(file_path);
      CREATE INDEX idx_digests_type ON digests(digest_type);
      CREATE INDEX idx_digests_status ON digests(status);

      -- Drop old digests backup
      DROP TABLE IF EXISTS digests_old;
    `);

    // Drop items table (no longer needed)
    db.exec(`
      DROP INDEX IF EXISTS idx_items_path_prefix;
      DROP INDEX IF EXISTS idx_items_detected_type;
      DROP INDEX IF EXISTS idx_items_status;
      DROP INDEX IF EXISTS idx_items_raw_type;
      DROP TABLE IF EXISTS items;
    `);

    // Create files table (rebuildable cache of file metadata)
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_folder INTEGER NOT NULL DEFAULT 0,
        size INTEGER,
        mime_type TEXT,
        hash TEXT,
        modified_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_scanned_at TEXT NOT NULL
      );

      CREATE INDEX idx_files_path_prefix ON files(path);
      CREATE INDEX idx_files_is_folder ON files(is_folder);
      CREATE INDEX idx_files_modified_at ON files(modified_at);
      CREATE INDEX idx_files_created_at ON files(created_at);
    `);

    // Note: sqlar table remains unchanged
    // Note: tasks table remains unchanged
    // Note: settings table remains unchanged
    // Note: search_documents table remains unchanged (will be updated in future migration)
  },

  async down(db: BetterSqlite3.Database) {
    // Drop new files table
    db.exec(`
      DROP INDEX IF EXISTS idx_files_created_at;
      DROP INDEX IF EXISTS idx_files_modified_at;
      DROP INDEX IF EXISTS idx_files_is_folder;
      DROP INDEX IF EXISTS idx_files_path_prefix;
      DROP TABLE IF EXISTS files;
    `);

    // Recreate items table
    db.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        raw_type TEXT NOT NULL,
        detected_type TEXT,
        is_folder INTEGER NOT NULL DEFAULT 0,
        path TEXT NOT NULL UNIQUE,
        files TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        schema_version INTEGER DEFAULT 1
      );

      CREATE INDEX idx_items_path_prefix ON items(path);
      CREATE INDEX idx_items_detected_type ON items(detected_type);
      CREATE INDEX idx_items_status ON items(status);
      CREATE INDEX idx_items_raw_type ON items(raw_type);
    `);

    // Recreate digests table with item_id
    db.exec(`
      DROP TABLE IF EXISTS digests_old;
      ALTER TABLE digests RENAME TO digests_old;
      DROP INDEX IF EXISTS idx_digests_file_path;
      DROP INDEX IF EXISTS idx_digests_type;
      DROP INDEX IF EXISTS idx_digests_status;

      CREATE TABLE digests (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        digest_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        content TEXT,
        sqlar_name TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_digests_item_id ON digests(item_id);
      CREATE INDEX idx_digests_type ON digests(digest_type);
      CREATE INDEX idx_digests_status ON digests(status);

      DROP TABLE IF EXISTS digests_old;
    `);

    // Recreate inbox_task_state table
    db.exec(`
      CREATE TABLE inbox_task_state (
        item_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        attempts INTEGER DEFAULT 0,
        error TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (item_id, task_type),
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_inbox_task_state_item_id ON inbox_task_state(item_id);
      CREATE INDEX idx_inbox_task_state_status ON inbox_task_state(status);
    `);
  },
};

export default migration;
