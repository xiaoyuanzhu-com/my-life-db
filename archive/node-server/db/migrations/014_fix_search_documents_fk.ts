import type BetterSqlite3 from 'better-sqlite3';

const TABLE_NAME = 'search_documents';

const migration = {
  version: 14,
  description: 'Fix search_documents foreign key to reference inbox entries',

  up(db: BetterSqlite3.Database) {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(TABLE_NAME) as { name?: string } | undefined;

    if (!tableExists) {
      return;
    }

    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`ALTER TABLE ${TABLE_NAME} RENAME TO ${TABLE_NAME}_old;`);

    createTable(db, {
      entryFk: 'REFERENCES inbox(id) ON DELETE CASCADE',
      tableName: TABLE_NAME,
    });
    createIndexes(db, TABLE_NAME);

    db.exec(`
      INSERT INTO ${TABLE_NAME} (
        document_id,
        entry_id,
        library_id,
        source_url,
        source_path,
        variant,
        chunk_index,
        chunk_count,
        span_start,
        span_end,
        overlap_tokens,
        word_count,
        token_count,
        content_hash,
        chunk_text,
        metadata_json,
        meili_status,
        meili_task_id,
        last_indexed_at,
        last_deindexed_at,
        embedding_status,
        embedding_version,
        last_embedded_at,
        last_error,
        created_at,
        updated_at
      )
      SELECT
        document_id,
        entry_id,
        library_id,
        source_url,
        source_path,
        variant,
        chunk_index,
        chunk_count,
        span_start,
        span_end,
        overlap_tokens,
        word_count,
        token_count,
        content_hash,
        chunk_text,
        metadata_json,
        meili_status,
        meili_task_id,
        last_indexed_at,
        last_deindexed_at,
        embedding_status,
        embedding_version,
        last_embedded_at,
        last_error,
        created_at,
        updated_at
      FROM ${TABLE_NAME}_old;
    `);

    db.exec(`DROP TABLE ${TABLE_NAME}_old;`);
    db.exec('PRAGMA foreign_keys = ON;');
  },

  down(db: BetterSqlite3.Database) {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(TABLE_NAME) as { name?: string } | undefined;

    if (!tableExists) {
      return;
    }

    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`ALTER TABLE ${TABLE_NAME} RENAME TO ${TABLE_NAME}_new;`);

    createTable(db, {
      entryFk: 'REFERENCES entries(id) ON DELETE CASCADE',
      tableName: TABLE_NAME,
    });
    createIndexes(db, TABLE_NAME);

    db.exec(`
      INSERT INTO ${TABLE_NAME}
      SELECT * FROM ${TABLE_NAME}_new;
    `);

    db.exec(`DROP TABLE ${TABLE_NAME}_new;`);
    db.exec('PRAGMA foreign_keys = ON;');
  },
};

export default migration;

function createTable(
  db: BetterSqlite3.Database,
  options: { tableName: string; entryFk: string }
) {
  db.exec(`
    CREATE TABLE ${options.tableName} (
      document_id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL ${options.entryFk},
      library_id TEXT,
      source_url TEXT,
      source_path TEXT NOT NULL,
      variant TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      span_start INTEGER NOT NULL,
      span_end INTEGER NOT NULL,
      overlap_tokens INTEGER NOT NULL,
      word_count INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      metadata_json TEXT,
      meili_status TEXT NOT NULL DEFAULT 'pending' CHECK(meili_status IN ('pending','indexing','indexed','deleting','deleted','error')),
      meili_task_id TEXT,
      last_indexed_at TEXT,
      last_deindexed_at TEXT,
      embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK(embedding_status IN ('pending','indexing','indexed','deleting','deleted','error')),
      embedding_version INTEGER NOT NULL DEFAULT 0,
      last_embedded_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(library_id) REFERENCES library(id) ON DELETE SET NULL
    );
  `);
}

function createIndexes(db: BetterSqlite3.Database, tableName: string) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_entry_variant
      ON ${tableName}(entry_id, variant);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_meili_status
      ON ${tableName}(meili_status)
      WHERE meili_status != 'indexed';
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_embedding_status
      ON ${tableName}(embedding_status)
      WHERE embedding_status != 'indexed';
  `);
}
