import type BetterSqlite3 from 'better-sqlite3';

const TABLE_NAME = 'search_documents';

const migration = {
  version: 13,
  description: 'Add search_documents table for Meilisearch/Qdrant ingestion',

  up(db: BetterSqlite3.Database) {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(TABLE_NAME) as { name?: string } | undefined;

    if (tableExists?.name === TABLE_NAME) {
      return;
    }

    db.exec(`
      CREATE TABLE ${TABLE_NAME} (
        document_id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
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
        FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE,
        FOREIGN KEY(library_id) REFERENCES library(id) ON DELETE SET NULL
      );
    `);

    db.exec(`
      CREATE INDEX idx_search_documents_entry_variant
        ON ${TABLE_NAME}(entry_id, variant);
    `);

    db.exec(`
      CREATE INDEX idx_search_documents_meili_status
        ON ${TABLE_NAME}(meili_status)
        WHERE meili_status != 'indexed';
    `);

    db.exec(`
      CREATE INDEX idx_search_documents_embedding_status
        ON ${TABLE_NAME}(embedding_status)
        WHERE embedding_status != 'indexed';
    `);
  },

  down(db: BetterSqlite3.Database) {
    db.exec(`DROP TABLE IF EXISTS ${TABLE_NAME};`);
  },
};

export default migration;
