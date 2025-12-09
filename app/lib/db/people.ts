/**
 * People Registry operations
 *
 * Manages people, clusters, and embeddings for face/voice identification.
 */

import { randomUUID } from 'crypto';
import { dbSelect, dbSelectOne, dbRun, dbTransaction } from './client';
import { getLogger } from '~/lib/log/logger';
import type {
  PeopleRecordRow,
  PeopleRecord,
  PeopleInput,
  PeopleWithCounts,
  PeopleClusterRow,
  PeopleCluster,
  PeopleClusterInput,
  ClusterType,
  PeopleEmbeddingRow,
  PeopleEmbedding,
  PeopleEmbeddingInput,
} from '~/types/models';
import {
  rowToPeopleRecord,
  rowToPeopleCluster,
  float32ArrayToBuffer,
  rowToPeopleEmbedding,
} from '~/types/models';

// Re-export types for convenience
export type {
  PeopleRecord,
  PeopleRecordRow,
  PeopleCluster,
  PeopleClusterRow,
  PeopleEmbedding,
  PeopleEmbeddingRow,
};

const log = getLogger({ module: 'DBPeople' });

// Similarity thresholds from design doc
const VOICE_SIMILARITY_THRESHOLD = 0.75;
const FACE_SIMILARITY_THRESHOLD = 0.80;

// =============================================================================
// PEOPLE CRUD
// =============================================================================

/**
 * Create a new people entry (identified or pending)
 */
export function createPeople(input: PeopleInput): PeopleRecord {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();

  dbRun(
    `INSERT INTO people (id, vcf_path, display_name, avatar, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.vcfPath ?? null, input.displayName ?? null, input.avatar ?? null, now, now]
  );

  log.info({ id, displayName: input.displayName }, 'created people');

  const people = getPeopleById(id);
  if (!people) throw new Error('Failed to create people');
  return people;
}

/**
 * Get people by ID
 */
export function getPeopleById(id: string): PeopleRecord | null {
  const row = dbSelectOne<PeopleRecordRow>(
    'SELECT * FROM people WHERE id = ?',
    [id]
  );
  return row ? rowToPeopleRecord(row) : null;
}

/**
 * Update people entry
 */
export function updatePeople(
  id: string,
  updates: Partial<Pick<PeopleInput, 'displayName' | 'vcfPath' | 'avatar'>>
): PeopleRecord | null {
  const now = new Date().toISOString();
  const setClauses: string[] = ['updated_at = ?'];
  const params: (string | Buffer | null)[] = [now];

  if ('displayName' in updates) {
    setClauses.push('display_name = ?');
    params.push(updates.displayName ?? null);
  }
  if ('vcfPath' in updates) {
    setClauses.push('vcf_path = ?');
    params.push(updates.vcfPath ?? null);
  }
  if ('avatar' in updates) {
    setClauses.push('avatar = ?');
    params.push(updates.avatar ?? null);
  }

  params.push(id);

  dbRun(`UPDATE people SET ${setClauses.join(', ')} WHERE id = ?`, params);
  log.info({ id, updates: Object.keys(updates) }, 'updated people');

  return getPeopleById(id);
}

/**
 * Delete people entry and cascade to clusters (embeddings become orphaned)
 */
export function deletePeople(id: string): void {
  dbTransaction(() => {
    // Due to CASCADE, clusters will be deleted automatically
    // Embeddings will have cluster_id set to NULL (SET NULL)
    dbRun('DELETE FROM people WHERE id = ?', [id]);
    log.info({ id }, 'deleted people');
  });
}

/**
 * List all people (identified first, then pending)
 */
export function listPeople(options?: {
  pendingOnly?: boolean;
  identifiedOnly?: boolean;
  limit?: number;
  offset?: number;
}): PeopleRecord[] {
  let query = 'SELECT * FROM people';
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options?.pendingOnly) {
    conditions.push('vcf_path IS NULL');
  } else if (options?.identifiedOnly) {
    conditions.push('vcf_path IS NOT NULL');
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  // Order: identified first (vcf_path NOT NULL), then by display_name, then created_at
  query += ' ORDER BY (vcf_path IS NULL) ASC, display_name ASC, created_at DESC';

  if (options?.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options?.offset) {
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  const rows = dbSelect<PeopleRecordRow>(query, params);
  return rows.map(rowToPeopleRecord);
}

/**
 * Count people
 */
export function countPeople(options?: { pendingOnly?: boolean; identifiedOnly?: boolean }): number {
  let query = 'SELECT COUNT(*) as count FROM people';

  if (options?.pendingOnly) {
    query += ' WHERE vcf_path IS NULL';
  } else if (options?.identifiedOnly) {
    query += ' WHERE vcf_path IS NOT NULL';
  }

  const result = dbSelectOne<{ count: number }>(query, []);
  return result?.count ?? 0;
}

/**
 * List people with cluster and embedding counts
 */
export function listPeopleWithCounts(options?: {
  pendingOnly?: boolean;
  identifiedOnly?: boolean;
  limit?: number;
  offset?: number;
}): PeopleWithCounts[] {
  let query = `
    SELECT p.*,
      (SELECT COUNT(*) FROM people_clusters c WHERE c.people_id = p.id AND c.type = 'voice') as voice_cluster_count,
      (SELECT COUNT(*) FROM people_clusters c WHERE c.people_id = p.id AND c.type = 'face') as face_cluster_count,
      (SELECT COUNT(*) FROM people_embeddings e
       INNER JOIN people_clusters c ON e.cluster_id = c.id
       WHERE c.people_id = p.id) as embedding_count
    FROM people p
  `;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options?.pendingOnly) {
    conditions.push('p.vcf_path IS NULL');
  } else if (options?.identifiedOnly) {
    conditions.push('p.vcf_path IS NOT NULL');
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY (p.vcf_path IS NULL) ASC, p.display_name ASC, p.created_at DESC';

  if (options?.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options?.offset) {
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  interface PeopleWithCountsRow extends PeopleRecordRow {
    voice_cluster_count: number;
    face_cluster_count: number;
    embedding_count: number;
  }

  const rows = dbSelect<PeopleWithCountsRow>(query, params);
  return rows.map((row) => ({
    ...rowToPeopleRecord(row),
    voiceClusterCount: row.voice_cluster_count,
    faceClusterCount: row.face_cluster_count,
    embeddingCount: row.embedding_count,
  }));
}

// =============================================================================
// CLUSTER CRUD
// =============================================================================

/**
 * Create a new cluster
 */
export function createCluster(input: PeopleClusterInput): PeopleCluster {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();

  dbRun(
    `INSERT INTO people_clusters (id, people_id, type, centroid, sample_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.peopleId,
      input.type,
      input.centroid ? float32ArrayToBuffer(input.centroid) : null,
      input.sampleCount ?? 0,
      now,
      now,
    ]
  );

  log.info({ id, peopleId: input.peopleId, type: input.type }, 'created cluster');

  const cluster = getClusterById(id);
  if (!cluster) throw new Error('Failed to create cluster');
  return cluster;
}

/**
 * Get cluster by ID
 */
export function getClusterById(id: string): PeopleCluster | null {
  const row = dbSelectOne<PeopleClusterRow>(
    'SELECT * FROM people_clusters WHERE id = ?',
    [id]
  );
  return row ? rowToPeopleCluster(row) : null;
}

/**
 * List clusters for a people entry
 */
export function listClustersForPeople(peopleId: string, type?: ClusterType): PeopleCluster[] {
  let query = 'SELECT * FROM people_clusters WHERE people_id = ?';
  const params: string[] = [peopleId];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  query += ' ORDER BY created_at ASC';

  const rows = dbSelect<PeopleClusterRow>(query, params);
  return rows.map(rowToPeopleCluster);
}

/**
 * Update cluster centroid and sample count
 */
export function updateCluster(
  id: string,
  updates: { centroid?: Float32Array | null; sampleCount?: number }
): PeopleCluster | null {
  const now = new Date().toISOString();
  const setClauses: string[] = ['updated_at = ?'];
  const params: (string | Buffer | number | null)[] = [now];

  if ('centroid' in updates) {
    setClauses.push('centroid = ?');
    params.push(updates.centroid ? float32ArrayToBuffer(updates.centroid) : null);
  }
  if ('sampleCount' in updates) {
    setClauses.push('sample_count = ?');
    params.push(updates.sampleCount ?? 0);
  }

  params.push(id);

  dbRun(`UPDATE people_clusters SET ${setClauses.join(', ')} WHERE id = ?`, params);
  log.debug({ id }, 'updated cluster');

  return getClusterById(id);
}

/**
 * Delete cluster (embeddings will have cluster_id set to NULL)
 */
export function deleteCluster(id: string): void {
  dbRun('DELETE FROM people_clusters WHERE id = ?', [id]);
  log.info({ id }, 'deleted cluster');
}

/**
 * Get all clusters of a specific type (for similarity search)
 */
export function listAllClusters(type: ClusterType): PeopleCluster[] {
  const rows = dbSelect<PeopleClusterRow>(
    'SELECT * FROM people_clusters WHERE type = ? AND centroid IS NOT NULL',
    [type]
  );
  return rows.map(rowToPeopleCluster);
}

// =============================================================================
// EMBEDDING CRUD
// =============================================================================

/**
 * Create a new embedding
 */
export function createEmbedding(input: PeopleEmbeddingInput): PeopleEmbedding {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();

  dbRun(
    `INSERT INTO people_embeddings (id, cluster_id, type, vector, source_path, source_offset, quality, manual_assignment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.clusterId ?? null,
      input.type,
      float32ArrayToBuffer(input.vector),
      input.sourcePath,
      input.sourceOffset ? JSON.stringify(input.sourceOffset) : null,
      input.quality ?? null,
      input.manualAssignment ? 1 : 0,
      now,
    ]
  );

  log.debug({ id, sourcePath: input.sourcePath, type: input.type }, 'created embedding');

  const embedding = getEmbeddingById(id);
  if (!embedding) throw new Error('Failed to create embedding');
  return embedding;
}

/**
 * Get embedding by ID
 */
export function getEmbeddingById(id: string): PeopleEmbedding | null {
  const row = dbSelectOne<PeopleEmbeddingRow>(
    'SELECT * FROM people_embeddings WHERE id = ?',
    [id]
  );
  return row ? rowToPeopleEmbedding(row) : null;
}

/**
 * List embeddings for a cluster
 */
export function listEmbeddingsForCluster(clusterId: string): PeopleEmbedding[] {
  const rows = dbSelect<PeopleEmbeddingRow>(
    'SELECT * FROM people_embeddings WHERE cluster_id = ? ORDER BY created_at ASC',
    [clusterId]
  );
  return rows.map(rowToPeopleEmbedding);
}

/**
 * List embeddings for a source file
 */
export function listEmbeddingsForSource(sourcePath: string): PeopleEmbedding[] {
  const rows = dbSelect<PeopleEmbeddingRow>(
    'SELECT * FROM people_embeddings WHERE source_path = ? ORDER BY created_at ASC',
    [sourcePath]
  );
  return rows.map(rowToPeopleEmbedding);
}

/**
 * List embeddings for a people entry (through their clusters)
 */
export function listEmbeddingsForPeople(peopleId: string, type?: ClusterType): PeopleEmbedding[] {
  let query = `
    SELECT e.* FROM people_embeddings e
    INNER JOIN people_clusters c ON e.cluster_id = c.id
    WHERE c.people_id = ?
  `;
  const params: string[] = [peopleId];

  if (type) {
    query += ' AND e.type = ?';
    params.push(type);
  }

  query += ' ORDER BY e.created_at ASC';

  const rows = dbSelect<PeopleEmbeddingRow>(query, params);
  return rows.map(rowToPeopleEmbedding);
}

/**
 * Update embedding assignment
 */
export function updateEmbedding(
  id: string,
  updates: { clusterId?: string | null; manualAssignment?: boolean }
): PeopleEmbedding | null {
  const setClauses: string[] = [];
  const params: (string | number | null)[] = [];

  if ('clusterId' in updates) {
    setClauses.push('cluster_id = ?');
    params.push(updates.clusterId ?? null);
  }
  if ('manualAssignment' in updates) {
    setClauses.push('manual_assignment = ?');
    params.push(updates.manualAssignment ? 1 : 0);
  }

  if (setClauses.length === 0) return getEmbeddingById(id);

  params.push(id);

  dbRun(`UPDATE people_embeddings SET ${setClauses.join(', ')} WHERE id = ?`, params);
  log.debug({ id }, 'updated embedding');

  return getEmbeddingById(id);
}

/**
 * Delete embedding
 */
export function deleteEmbedding(id: string): void {
  dbRun('DELETE FROM people_embeddings WHERE id = ?', [id]);
  log.debug({ id }, 'deleted embedding');
}

/**
 * Delete all embeddings for a source path
 * Also cleans up orphaned clusters and people
 */
export function deleteEmbeddingsForSource(sourcePath: string): number {
  const result = dbRun(
    'DELETE FROM people_embeddings WHERE source_path = ?',
    [sourcePath]
  );
  log.info({ sourcePath, count: result.changes }, 'deleted embeddings for source');

  // Clean up orphaned clusters (no embeddings pointing to them)
  const clustersDeleted = dbRun(`
    DELETE FROM people_clusters
    WHERE id NOT IN (SELECT DISTINCT cluster_id FROM people_embeddings WHERE cluster_id IS NOT NULL)
  `, []);
  if (clustersDeleted.changes > 0) {
    log.info({ count: clustersDeleted.changes }, 'deleted orphaned clusters');
  }

  // Clean up orphaned placeholder people (no clusters, no name, no vcf_path)
  const peopleDeleted = dbRun(`
    DELETE FROM people
    WHERE id NOT IN (SELECT DISTINCT people_id FROM people_clusters)
      AND (display_name IS NULL OR display_name = '')
      AND vcf_path IS NULL
  `, []);
  if (peopleDeleted.changes > 0) {
    log.info({ count: peopleDeleted.changes }, 'deleted orphaned placeholder people');
  }

  return result.changes;
}

/**
 * Delete all embeddings (for full reset)
 * Also cleans up orphaned clusters and placeholder people
 */
export function deleteAllEmbeddings(): number {
  const result = dbRun('DELETE FROM people_embeddings', []);
  log.info({ count: result.changes }, 'deleted all embeddings');

  // Clean up orphaned clusters (no embeddings pointing to them)
  const clustersDeleted = dbRun(`
    DELETE FROM people_clusters
    WHERE id NOT IN (SELECT DISTINCT cluster_id FROM people_embeddings WHERE cluster_id IS NOT NULL)
  `, []);
  log.info({ count: clustersDeleted.changes }, 'deleted orphaned clusters');

  // Clean up orphaned placeholder people (no clusters, no name, no vcf_path)
  const peopleDeleted = dbRun(`
    DELETE FROM people
    WHERE id NOT IN (SELECT DISTINCT people_id FROM people_clusters)
      AND (display_name IS NULL OR display_name = '')
      AND vcf_path IS NULL
  `, []);
  log.info({ count: peopleDeleted.changes }, 'deleted orphaned placeholder people');

  return result.changes;
}

// =============================================================================
// CLUSTERING LOGIC
// =============================================================================

/**
 * Calculate cosine similarity between two vectors
 * Assumes vectors are L2-normalized
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * L2 normalize a vector
 */
export function l2Normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);

  if (norm === 0) return vector;

  const normalized = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    normalized[i] = vector[i] / norm;
  }
  return normalized;
}

/**
 * Find the best matching cluster for an embedding
 * Returns null if no cluster meets the similarity threshold
 */
export function findBestMatchingCluster(
  vector: Float32Array,
  type: ClusterType
): { cluster: PeopleCluster; similarity: number } | null {
  const clusters = listAllClusters(type);
  const threshold = type === 'voice' ? VOICE_SIMILARITY_THRESHOLD : FACE_SIMILARITY_THRESHOLD;

  let bestMatch: { cluster: PeopleCluster; similarity: number } | null = null;

  for (const cluster of clusters) {
    if (!cluster.centroid) continue;

    const similarity = cosineSimilarity(vector, cluster.centroid);
    if (similarity > threshold && (!bestMatch || similarity > bestMatch.similarity)) {
      bestMatch = { cluster, similarity };
    }
  }

  return bestMatch;
}

/**
 * Update cluster centroid after adding a new embedding
 * Formula: new_centroid = (old_centroid * n + new_embedding) / (n + 1)
 */
export function updateCentroidForAddition(
  cluster: PeopleCluster,
  newEmbedding: Float32Array
): Float32Array {
  const n = cluster.sampleCount;

  if (!cluster.centroid || n === 0) {
    // First embedding becomes the centroid
    return l2Normalize(newEmbedding);
  }

  const newCentroid = new Float32Array(cluster.centroid.length);
  for (let i = 0; i < cluster.centroid.length; i++) {
    newCentroid[i] = (cluster.centroid[i] * n + newEmbedding[i]) / (n + 1);
  }

  return l2Normalize(newCentroid);
}

/**
 * Update cluster centroid after removing an embedding
 * Formula: new_centroid = (old_centroid * n - removed_embedding) / (n - 1)
 */
export function updateCentroidForRemoval(
  cluster: PeopleCluster,
  removedEmbedding: Float32Array
): Float32Array | null {
  const n = cluster.sampleCount;

  if (n <= 1 || !cluster.centroid) {
    // Cluster will be empty
    return null;
  }

  const newCentroid = new Float32Array(cluster.centroid.length);
  for (let i = 0; i < cluster.centroid.length; i++) {
    newCentroid[i] = (cluster.centroid[i] * n - removedEmbedding[i]) / (n - 1);
  }

  return l2Normalize(newCentroid);
}

/**
 * Calculate merged centroid for two clusters
 * Formula: merged_centroid = (centroid_a * n_a + centroid_b * n_b) / (n_a + n_b)
 */
export function calculateMergedCentroid(
  clusterA: PeopleCluster,
  clusterB: PeopleCluster
): Float32Array | null {
  if (!clusterA.centroid || !clusterB.centroid) {
    return clusterA.centroid ?? clusterB.centroid ?? null;
  }

  const nA = clusterA.sampleCount;
  const nB = clusterB.sampleCount;
  const totalCount = nA + nB;

  if (totalCount === 0) return null;

  const merged = new Float32Array(clusterA.centroid.length);
  for (let i = 0; i < clusterA.centroid.length; i++) {
    merged[i] = (clusterA.centroid[i] * nA + clusterB.centroid[i] * nB) / totalCount;
  }

  return l2Normalize(merged);
}

// =============================================================================
// AUTO-CLUSTERING
// =============================================================================

/**
 * Add an embedding to the system with auto-clustering
 *
 * If manualAssignment is true, the embedding is NOT auto-clustered.
 * Otherwise, find the best matching cluster or create a new one.
 */
export function addEmbeddingWithClustering(
  input: PeopleEmbeddingInput
): { embedding: PeopleEmbedding; cluster: PeopleCluster; people: PeopleRecord; isNewPeople: boolean } {
  return dbTransaction(() => {
    const normalizedVector = l2Normalize(input.vector);

    // If manual assignment, just create the embedding without clustering
    if (input.manualAssignment) {
      createEmbedding({
        ...input,
        vector: normalizedVector,
        manualAssignment: true,
      });
      // For manual assignments, we don't auto-cluster
      // The embedding will need to be manually assigned to a people/cluster
      throw new Error('Manual assignment requires explicit cluster/people assignment');
    }

    // Find best matching cluster
    const match = findBestMatchingCluster(normalizedVector, input.type);

    if (match) {
      // Add to existing cluster
      const embedding = createEmbedding({
        ...input,
        vector: normalizedVector,
        clusterId: match.cluster.id,
      });

      // Update centroid
      const newCentroid = updateCentroidForAddition(match.cluster, normalizedVector);
      updateCluster(match.cluster.id, {
        centroid: newCentroid,
        sampleCount: match.cluster.sampleCount + 1,
      });

      const people = getPeopleById(match.cluster.peopleId);
      if (!people) throw new Error('Cluster has no people');

      log.info(
        { embeddingId: embedding.id, clusterId: match.cluster.id, peopleId: people.id, similarity: match.similarity },
        'added embedding to existing cluster'
      );

      return { embedding, cluster: match.cluster, people, isNewPeople: false };
    } else {
      // Create new cluster and pending people
      const people = createPeople({});
      const cluster = createCluster({
        peopleId: people.id,
        type: input.type,
        centroid: normalizedVector,
        sampleCount: 1,
      });

      const embedding = createEmbedding({
        ...input,
        vector: normalizedVector,
        clusterId: cluster.id,
      });

      log.info(
        { embeddingId: embedding.id, clusterId: cluster.id, peopleId: people.id },
        'created new cluster and pending people'
      );

      return { embedding, cluster, people, isNewPeople: true };
    }
  });
}

// =============================================================================
// MERGE & UNASSIGN OPERATIONS
// =============================================================================

/**
 * Merge two people: move all clusters from source to target, delete source
 */
export function mergePeople(targetId: string, sourceId: string): PeopleRecord {
  return dbTransaction(() => {
    const target = getPeopleById(targetId);
    const source = getPeopleById(sourceId);

    if (!target) throw new Error(`Target people not found: ${targetId}`);
    if (!source) throw new Error(`Source people not found: ${sourceId}`);
    if (targetId === sourceId) throw new Error('Cannot merge people with itself');

    // Move all clusters from source to target
    dbRun(
      'UPDATE people_clusters SET people_id = ?, updated_at = ? WHERE people_id = ?',
      [targetId, new Date().toISOString(), sourceId]
    );

    // Delete source people
    deletePeople(sourceId);

    log.info({ targetId, sourceId }, 'merged people');

    return target;
  });
}

/**
 * Unassign embedding from cluster
 * Sets manual_assignment = true to prevent re-clustering
 */
export function unassignEmbedding(embeddingId: string): void {
  dbTransaction(() => {
    const embedding = getEmbeddingById(embeddingId);
    if (!embedding) throw new Error(`Embedding not found: ${embeddingId}`);

    const clusterId = embedding.clusterId;
    if (!clusterId) {
      // Already unassigned
      updateEmbedding(embeddingId, { manualAssignment: true });
      return;
    }

    const cluster = getClusterById(clusterId);
    if (!cluster) throw new Error(`Cluster not found: ${clusterId}`);

    // Remove from cluster
    updateEmbedding(embeddingId, { clusterId: null, manualAssignment: true });

    // Update cluster centroid
    if (cluster.sampleCount <= 1) {
      // Cluster will be empty - check if we should delete it
      const peopleId = cluster.peopleId;
      deleteCluster(clusterId);

      // Check if people has no clusters left and is pending
      const remainingClusters = listClustersForPeople(peopleId);
      if (remainingClusters.length === 0) {
        const people = getPeopleById(peopleId);
        if (people?.isPending) {
          deletePeople(peopleId);
          log.info({ peopleId }, 'deleted empty pending people');
        }
      }
    } else {
      // Update centroid
      const newCentroid = updateCentroidForRemoval(cluster, embedding.vector);
      updateCluster(clusterId, {
        centroid: newCentroid,
        sampleCount: cluster.sampleCount - 1,
      });
    }

    log.info({ embeddingId, clusterId }, 'unassigned embedding from cluster');
  });
}

/**
 * Assign embedding to a specific people's cluster (manual assignment)
 * Creates a new cluster for the people if needed
 */
export function assignEmbeddingToPeople(
  embeddingId: string,
  peopleId: string
): { embedding: PeopleEmbedding; cluster: PeopleCluster } {
  return dbTransaction(() => {
    const embedding = getEmbeddingById(embeddingId);
    if (!embedding) throw new Error(`Embedding not found: ${embeddingId}`);

    const people = getPeopleById(peopleId);
    if (!people) throw new Error(`People not found: ${peopleId}`);

    // Find an existing cluster of the same type, or create new
    const existingClusters = listClustersForPeople(peopleId, embedding.type);
    let targetCluster: PeopleCluster;

    if (existingClusters.length > 0) {
      // Find best matching cluster for this people
      let bestMatch: { cluster: PeopleCluster; similarity: number } | null = null;

      for (const cluster of existingClusters) {
        if (!cluster.centroid) continue;
        const similarity = cosineSimilarity(embedding.vector, cluster.centroid);
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { cluster, similarity };
        }
      }

      if (bestMatch) {
        targetCluster = bestMatch.cluster;
      } else {
        // Use first cluster if no centroids (shouldn't happen)
        targetCluster = existingClusters[0];
      }
    } else {
      // Create new cluster for this people
      targetCluster = createCluster({
        peopleId,
        type: embedding.type,
        centroid: embedding.vector,
        sampleCount: 0,
      });
    }

    // If embedding was in another cluster, handle removal
    if (embedding.clusterId && embedding.clusterId !== targetCluster.id) {
      const oldCluster = getClusterById(embedding.clusterId);
      if (oldCluster) {
        if (oldCluster.sampleCount <= 1) {
          const oldPeopleId = oldCluster.peopleId;
          deleteCluster(oldCluster.id);

          // Clean up empty pending people
          const remainingClusters = listClustersForPeople(oldPeopleId);
          if (remainingClusters.length === 0) {
            const oldPeople = getPeopleById(oldPeopleId);
            if (oldPeople?.isPending) {
              deletePeople(oldPeopleId);
            }
          }
        } else {
          const newCentroid = updateCentroidForRemoval(oldCluster, embedding.vector);
          updateCluster(oldCluster.id, {
            centroid: newCentroid,
            sampleCount: oldCluster.sampleCount - 1,
          });
        }
      }
    }

    // Add to target cluster
    updateEmbedding(embeddingId, { clusterId: targetCluster.id, manualAssignment: true });

    // Update target cluster centroid
    const updatedCluster = getClusterById(targetCluster.id);
    if (updatedCluster) {
      const newCentroid = updateCentroidForAddition(updatedCluster, embedding.vector);
      updateCluster(targetCluster.id, {
        centroid: newCentroid,
        sampleCount: updatedCluster.sampleCount + 1,
      });
    }

    const finalEmbedding = getEmbeddingById(embeddingId);
    const finalCluster = getClusterById(targetCluster.id);

    if (!finalEmbedding || !finalCluster) {
      throw new Error('Failed to assign embedding');
    }

    log.info({ embeddingId, peopleId, clusterId: targetCluster.id }, 'assigned embedding to people');

    return { embedding: finalEmbedding, cluster: finalCluster };
  });
}

// =============================================================================
// SOURCE FILE DELETION HANDLING
// =============================================================================

/**
 * Handle source file deletion
 * Deletes all embeddings for the source, cascades to empty clusters and pending people
 */
export function handleSourceFileDeletion(sourcePath: string): void {
  dbTransaction(() => {
    // Get all embeddings for this source
    const embeddings = listEmbeddingsForSource(sourcePath);

    // Track clusters that might become empty
    const clusterIds = new Set<string>();
    for (const emb of embeddings) {
      if (emb.clusterId) {
        clusterIds.add(emb.clusterId);
      }
    }

    // Delete all embeddings
    deleteEmbeddingsForSource(sourcePath);

    // Check and clean up clusters
    for (const clusterId of clusterIds) {
      const cluster = getClusterById(clusterId);
      if (!cluster) continue;

      // Count remaining embeddings
      const remaining = listEmbeddingsForCluster(clusterId);
      if (remaining.length === 0) {
        const peopleId = cluster.peopleId;
        deleteCluster(clusterId);

        // Check if people has no clusters left and is pending
        const remainingClusters = listClustersForPeople(peopleId);
        if (remainingClusters.length === 0) {
          const people = getPeopleById(peopleId);
          if (people?.isPending) {
            deletePeople(peopleId);
            log.info({ peopleId, sourcePath }, 'deleted empty pending people after source deletion');
          }
        }
      } else {
        // Recalculate centroid from remaining embeddings
        const vectors = remaining.map((e) => e.vector);
        const newCentroid = calculateAverageCentroid(vectors);
        updateCluster(clusterId, {
          centroid: newCentroid,
          sampleCount: remaining.length,
        });
      }
    }

    log.info({ sourcePath, embeddingCount: embeddings.length }, 'handled source file deletion');
  });
}

/**
 * Calculate average centroid from multiple vectors
 */
function calculateAverageCentroid(vectors: Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null;

  const result = new Float32Array(vectors[0].length);
  for (const vector of vectors) {
    for (let i = 0; i < vector.length; i++) {
      result[i] += vector[i];
    }
  }

  for (let i = 0; i < result.length; i++) {
    result[i] /= vectors.length;
  }

  return l2Normalize(result);
}
