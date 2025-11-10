import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 15,
  description: 'Add content_type column to search_documents for unified search',

  up(db: BetterSqlite3.Database) {
    // Add content_type column with default 'url' for existing rows
    db.exec(`
      ALTER TABLE search_documents ADD COLUMN content_type TEXT NOT NULL DEFAULT 'url'
        CHECK(content_type IN ('text', 'url', 'image', 'audio', 'video', 'pdf', 'mixed'));
    `);

    // Create index on content_type for filtering
    db.exec(`
      CREATE INDEX idx_search_documents_content_type ON search_documents(content_type);
    `);

    // Update existing rows based on variant (best effort migration)
    // Old variants: 'url-content-md', 'url-content-html', 'url-summary'
    // All existing data is from URLs, so 'url' is correct
    db.exec(`
      UPDATE search_documents SET content_type = 'url' WHERE content_type = 'url';
    `);

    // Update variant values to new schema
    // Old: 'url-content-md', 'url-content-html', 'url-summary'
    // New: 'content', 'summary', 'raw'
    db.exec(`
      UPDATE search_documents
      SET variant = CASE
        WHEN variant IN ('url-content-md', 'url-content-html') THEN 'content'
        WHEN variant = 'url-summary' THEN 'summary'
        ELSE variant
      END;
    `);
  },

  down(db: BetterSqlite3.Database) {
    // Revert variant changes
    db.exec(`
      UPDATE search_documents
      SET variant = CASE
        WHEN variant = 'content' AND content_type = 'url' THEN 'url-content-md'
        WHEN variant = 'summary' AND content_type = 'url' THEN 'url-summary'
        ELSE variant
      END;
    `);

    // Drop the index
    db.exec(`DROP INDEX IF EXISTS idx_search_documents_content_type;`);

    // Drop the column
    db.exec(`
      ALTER TABLE search_documents DROP COLUMN content_type;
    `);
  },
};

export default migration;
