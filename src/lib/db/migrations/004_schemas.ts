// Metadata schemas registry for schema evolution tracking
import type BetterSqlite3 from 'better-sqlite3';

export default {
  version: 4,
  description: 'Create metadata schemas registry for schema evolution',

  async up(db: BetterSqlite3.Database) {
    // Schema version tracking
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT DEFAULT CURRENT_TIMESTAMP,
        description TEXT
      );
    `);

    // Metadata schemas registry
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata_schemas (
        version INTEGER NOT NULL,
        table_name TEXT NOT NULL,
        field_name TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (table_name, field_name, version)
      );
    `);

    // Register initial schemas
    db.exec(`
      INSERT OR IGNORE INTO metadata_schemas (version, table_name, field_name, schema_json)
      VALUES
      (1, 'inbox', 'files', '{
        "type": "array",
        "items": {
          "type": "object",
          "required": ["filename", "size", "mimeType", "type"],
          "properties": {
            "filename": {"type": "string"},
            "size": {"type": "integer"},
            "mimeType": {"type": "string"},
            "type": {"type": "string", "enum": ["text", "image", "audio", "video", "pdf", "other"]},
            "hash": {"type": "string"},
            "enrichment": {"type": "object"}
          }
        }
      }'),
      (1, 'library', 'enrichment', '{
        "type": "object",
        "properties": {
          "caption": {"type": "string"},
          "ocr": {"type": "string"},
          "summary": {"type": "string"},
          "tags": {"type": "array", "items": {"type": "string"}},
          "faces": {"type": "array"}
        }
      }');
    `);
  },

  async down(db: BetterSqlite3.Database) {
    db.exec(`DROP TABLE IF EXISTS metadata_schemas;`);
    db.exec(`DROP TABLE IF EXISTS schema_version;`);
  },
};
