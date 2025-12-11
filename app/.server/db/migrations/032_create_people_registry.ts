import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 32,
  description: 'Create people registry tables (people, person_clusters, person_embeddings)',

  async up(db: BetterSqlite3.Database) {
    // People table - stores both identified (with vcf_path) and pending (without) people
    db.exec(`
      CREATE TABLE people (
        id TEXT PRIMARY KEY,
        vcf_path TEXT,
        display_name TEXT,
        avatar BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_people_vcf_path ON people(vcf_path);
      CREATE INDEX idx_people_display_name ON people(display_name);
    `);

    // Person clusters - groupings of embeddings linked to a person
    db.exec(`
      CREATE TABLE person_clusters (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        type TEXT NOT NULL,
        centroid BLOB,
        sample_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_clusters_person_id ON person_clusters(person_id);
      CREATE INDEX idx_clusters_type ON person_clusters(type);
    `);

    // Person embeddings - biometric vectors from media files
    db.exec(`
      CREATE TABLE person_embeddings (
        id TEXT PRIMARY KEY,
        cluster_id TEXT,
        type TEXT NOT NULL,
        vector BLOB NOT NULL,
        source_path TEXT NOT NULL,
        source_offset TEXT,
        quality REAL,
        manual_assignment INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (cluster_id) REFERENCES person_clusters(id) ON DELETE SET NULL,
        FOREIGN KEY (source_path) REFERENCES files(path) ON DELETE CASCADE
      );

      CREATE INDEX idx_embeddings_cluster_id ON person_embeddings(cluster_id);
      CREATE INDEX idx_embeddings_source_path ON person_embeddings(source_path);
      CREATE INDEX idx_embeddings_type ON person_embeddings(type);
    `);
  },

  async down(db: BetterSqlite3.Database) {
    db.exec(`
      DROP TABLE IF EXISTS person_embeddings;
      DROP TABLE IF EXISTS person_clusters;
      DROP TABLE IF EXISTS people;
    `);
  },
};

export default migration;
