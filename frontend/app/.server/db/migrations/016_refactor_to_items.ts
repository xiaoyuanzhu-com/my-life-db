// Major refactor: items-based architecture
// - Drop old inbox and library tables
// - Create unified items table
// - Create digests table for AI-generated content
// - Create sqlar table for compressed binary digests
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 16,
  description: 'Refactor to items-based architecture with digests and SQLAR',

  async up(db: BetterSqlite3.Database) {
    // Drop old tables
    db.exec(`
      DROP TABLE IF EXISTS inbox;
      DROP TABLE IF EXISTS library;
      DROP INDEX IF EXISTS idx_inbox_status;
      DROP INDEX IF EXISTS idx_inbox_folder_name;
      DROP INDEX IF EXISTS idx_library_path_prefix;
      DROP INDEX IF EXISTS idx_library_modified;
      DROP INDEX IF EXISTS idx_library_content_type;
      DROP INDEX IF EXISTS idx_library_schema_version;
    `);

    // Create new items table (unified inbox + library)
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

    // Create digests table (AI-generated content)
    db.exec(`
      CREATE TABLE digests (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        digest_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        content TEXT,
        sqlar_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_digests_item_id ON digests(item_id);
      CREATE INDEX idx_digests_type ON digests(digest_type);
      CREATE INDEX idx_digests_status ON digests(status);
    `);

    // Create SQLAR table (SQLite Archive format for binary digests)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sqlar(
        name TEXT PRIMARY KEY,
        mode INT,
        mtime INT,
        sz INT,
        data BLOB
      );
    `);

    // Update inbox_task_state to reference items instead of inbox
    db.exec(`
      DROP TABLE IF EXISTS inbox_task_state;

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

  async down(db: BetterSqlite3.Database) {
    // Drop new tables
    db.exec(`
      DROP INDEX IF EXISTS idx_inbox_task_state_status;
      DROP INDEX IF EXISTS idx_inbox_task_state_item_id;
      DROP TABLE IF EXISTS inbox_task_state;
      DROP TABLE IF EXISTS sqlar;
      DROP INDEX IF EXISTS idx_digests_status;
      DROP INDEX IF EXISTS idx_digests_type;
      DROP INDEX IF EXISTS idx_digests_item_id;
      DROP TABLE IF EXISTS digests;
      DROP INDEX IF EXISTS idx_items_raw_type;
      DROP INDEX IF EXISTS idx_items_status;
      DROP INDEX IF EXISTS idx_items_detected_type;
      DROP INDEX IF EXISTS idx_items_path_prefix;
      DROP TABLE IF EXISTS items;
    `);

    // Note: Not recreating old tables as this is a breaking change
    // Rollback should only be used in development
  },
};

export default migration;
