import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 33,
  description: 'Rename person_clusters to people_clusters, person_embeddings to people_embeddings, and person_id to people_id',

  async up(db: BetterSqlite3.Database) {
    // Rename person_clusters to people_clusters
    db.exec(`
      ALTER TABLE person_clusters RENAME TO people_clusters;
    `);

    // Rename person_id column to people_id in people_clusters
    db.exec(`
      ALTER TABLE people_clusters RENAME COLUMN person_id TO people_id;
    `);

    // Rename person_embeddings to people_embeddings
    db.exec(`
      ALTER TABLE person_embeddings RENAME TO people_embeddings;
    `);

    // Recreate indexes with new names
    db.exec(`
      DROP INDEX IF EXISTS idx_clusters_person_id;
      DROP INDEX IF EXISTS idx_clusters_type;
      DROP INDEX IF EXISTS idx_embeddings_cluster_id;
      DROP INDEX IF EXISTS idx_embeddings_source_path;
      DROP INDEX IF EXISTS idx_embeddings_type;

      CREATE INDEX idx_people_clusters_people_id ON people_clusters(people_id);
      CREATE INDEX idx_people_clusters_type ON people_clusters(type);
      CREATE INDEX idx_people_embeddings_cluster_id ON people_embeddings(cluster_id);
      CREATE INDEX idx_people_embeddings_source_path ON people_embeddings(source_path);
      CREATE INDEX idx_people_embeddings_type ON people_embeddings(type);
    `);
  },

  async down(db: BetterSqlite3.Database) {
    // Rename back to person_embeddings
    db.exec(`
      ALTER TABLE people_embeddings RENAME TO person_embeddings;
    `);

    // Rename people_id back to person_id
    db.exec(`
      ALTER TABLE people_clusters RENAME COLUMN people_id TO person_id;
    `);

    // Rename back to person_clusters
    db.exec(`
      ALTER TABLE people_clusters RENAME TO person_clusters;
    `);

    // Recreate original indexes
    db.exec(`
      DROP INDEX IF EXISTS idx_people_clusters_people_id;
      DROP INDEX IF EXISTS idx_people_clusters_type;
      DROP INDEX IF EXISTS idx_people_embeddings_cluster_id;
      DROP INDEX IF EXISTS idx_people_embeddings_source_path;
      DROP INDEX IF EXISTS idx_people_embeddings_type;

      CREATE INDEX idx_clusters_person_id ON person_clusters(person_id);
      CREATE INDEX idx_clusters_type ON person_clusters(type);
      CREATE INDEX idx_embeddings_cluster_id ON person_embeddings(cluster_id);
      CREATE INDEX idx_embeddings_source_path ON person_embeddings(source_path);
      CREATE INDEX idx_embeddings_type ON person_embeddings(type);
    `);
  },
};

export default migration;
