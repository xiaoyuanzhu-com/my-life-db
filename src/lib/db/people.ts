/**
 * People Registry operations
 *
 * Manages people, clusters, and embeddings for face/voice identification.
 */

import { randomUUID } from 'crypto';
import { dbSelect, dbSelectOne, dbRun, dbTransaction } from './client';
import { getLogger } from '@/lib/log/logger';
import type {
  PersonRecordRow,
  PersonRecord,
  PersonInput,
  PersonWithCounts,
  PersonClusterRow,
  PersonCluster,
  PersonClusterInput,
  ClusterType,
  PersonEmbeddingRow,
  PersonEmbedding,
  PersonEmbeddingInput,
  SourceOffset,
} from '@/types/models';
import {
  rowToPersonRecord,
  rowToPersonCluster,
  float32ArrayToBuffer,
  rowToPersonEmbedding,
} from '@/types/models';

// Re-export types for convenience
export type {
  PersonRecord,
  PersonRecordRow,
  PersonCluster,
  PersonClusterRow,
  PersonEmbedding,
  PersonEmbeddingRow,
};

const log = getLogger({ module: 'DBPeople' });

// Similarity thresholds from design doc
const VOICE_SIMILARITY_THRESHOLD = 0.85;
const FACE_SIMILARITY_THRESHOLD = 0.80;

// =============================================================================
// PEOPLE CRUD
// =============================================================================

/**
 * Create a new person (identified or pending)
 */
export function createPerson(input: PersonInput): PersonRecord {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();

  dbRun(
    `INSERT INTO people (id, vcf_path, display_name, avatar, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.vcfPath ?? null, input.displayName ?? null, input.avatar ?? null, now, now]
  );

  log.info({ id, displayName: input.displayName }, 'created person');

  const person = getPersonById(id);
  if (!person) throw new Error('Failed to create person');
  return person;
}

/**
 * Get person by ID
 */
export function getPersonById(id: string): PersonRecord | null {
  const row = dbSelectOne<PersonRecordRow>(
    'SELECT * FROM people WHERE id = ?',
    [id]
  );
  return row ? rowToPersonRecord(row) : null;
}

/**
 * Update person
 */
export function updatePerson(
  id: string,
  updates: Partial<Pick<PersonInput, 'displayName' | 'vcfPath' | 'avatar'>>
): PersonRecord | null {
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
  log.info({ id, updates: Object.keys(updates) }, 'updated person');

  return getPersonById(id);
}

/**
 * Delete person and cascade to clusters (embeddings become orphaned)
 */
export function deletePerson(id: string): void {
  dbTransaction(() => {
    // Due to CASCADE, clusters will be deleted automatically
    // Embeddings will have cluster_id set to NULL (SET NULL)
    dbRun('DELETE FROM people WHERE id = ?', [id]);
    log.info({ id }, 'deleted person');
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
}): PersonRecord[] {
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

  const rows = dbSelect<PersonRecordRow>(query, params);
  return rows.map(rowToPersonRecord);
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
}): PersonWithCounts[] {
  let query = `
    SELECT p.*,
      (SELECT COUNT(*) FROM person_clusters c WHERE c.person_id = p.id AND c.type = 'voice') as voice_cluster_count,
      (SELECT COUNT(*) FROM person_clusters c WHERE c.person_id = p.id AND c.type = 'face') as face_cluster_count,
      (SELECT COUNT(*) FROM person_embeddings e
       INNER JOIN person_clusters c ON e.cluster_id = c.id
       WHERE c.person_id = p.id) as embedding_count
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

  interface PersonWithCountsRow extends PersonRecordRow {
    voice_cluster_count: number;
    face_cluster_count: number;
    embedding_count: number;
  }

  const rows = dbSelect<PersonWithCountsRow>(query, params);
  return rows.map((row) => ({
    ...rowToPersonRecord(row),
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
export function createCluster(input: PersonClusterInput): PersonCluster {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();

  dbRun(
    `INSERT INTO person_clusters (id, person_id, type, centroid, sample_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.personId,
      input.type,
      input.centroid ? float32ArrayToBuffer(input.centroid) : null,
      input.sampleCount ?? 0,
      now,
      now,
    ]
  );

  log.info({ id, personId: input.personId, type: input.type }, 'created cluster');

  const cluster = getClusterById(id);
  if (!cluster) throw new Error('Failed to create cluster');
  return cluster;
}

/**
 * Get cluster by ID
 */
export function getClusterById(id: string): PersonCluster | null {
  const row = dbSelectOne<PersonClusterRow>(
    'SELECT * FROM person_clusters WHERE id = ?',
    [id]
  );
  return row ? rowToPersonCluster(row) : null;
}

/**
 * List clusters for a person
 */
export function listClustersForPerson(personId: string, type?: ClusterType): PersonCluster[] {
  let query = 'SELECT * FROM person_clusters WHERE person_id = ?';
  const params: string[] = [personId];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  query += ' ORDER BY created_at ASC';

  const rows = dbSelect<PersonClusterRow>(query, params);
  return rows.map(rowToPersonCluster);
}

/**
 * Update cluster centroid and sample count
 */
export function updateCluster(
  id: string,
  updates: { centroid?: Float32Array | null; sampleCount?: number }
): PersonCluster | null {
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

  dbRun(`UPDATE person_clusters SET ${setClauses.join(', ')} WHERE id = ?`, params);
  log.debug({ id }, 'updated cluster');

  return getClusterById(id);
}

/**
 * Delete cluster (embeddings will have cluster_id set to NULL)
 */
export function deleteCluster(id: string): void {
  dbRun('DELETE FROM person_clusters WHERE id = ?', [id]);
  log.info({ id }, 'deleted cluster');
}

/**
 * Get all clusters of a specific type (for similarity search)
 */
export function listAllClusters(type: ClusterType): PersonCluster[] {
  const rows = dbSelect<PersonClusterRow>(
    'SELECT * FROM person_clusters WHERE type = ? AND centroid IS NOT NULL',
    [type]
  );
  return rows.map(rowToPersonCluster);
}

// =============================================================================
// EMBEDDING CRUD
// =============================================================================

/**
 * Create a new embedding
 */
export function createEmbedding(input: PersonEmbeddingInput): PersonEmbedding {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();

  dbRun(
    `INSERT INTO person_embeddings (id, cluster_id, type, vector, source_path, source_offset, quality, manual_assignment, created_at)
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
export function getEmbeddingById(id: string): PersonEmbedding | null {
  const row = dbSelectOne<PersonEmbeddingRow>(
    'SELECT * FROM person_embeddings WHERE id = ?',
    [id]
  );
  return row ? rowToPersonEmbedding(row) : null;
}

/**
 * List embeddings for a cluster
 */
export function listEmbeddingsForCluster(clusterId: string): PersonEmbedding[] {
  const rows = dbSelect<PersonEmbeddingRow>(
    'SELECT * FROM person_embeddings WHERE cluster_id = ? ORDER BY created_at ASC',
    [clusterId]
  );
  return rows.map(rowToPersonEmbedding);
}

/**
 * List embeddings for a source file
 */
export function listEmbeddingsForSource(sourcePath: string): PersonEmbedding[] {
  const rows = dbSelect<PersonEmbeddingRow>(
    'SELECT * FROM person_embeddings WHERE source_path = ? ORDER BY created_at ASC',
    [sourcePath]
  );
  return rows.map(rowToPersonEmbedding);
}

/**
 * List embeddings for a person (through their clusters)
 */
export function listEmbeddingsForPerson(personId: string, type?: ClusterType): PersonEmbedding[] {
  let query = `
    SELECT e.* FROM person_embeddings e
    INNER JOIN person_clusters c ON e.cluster_id = c.id
    WHERE c.person_id = ?
  `;
  const params: string[] = [personId];

  if (type) {
    query += ' AND e.type = ?';
    params.push(type);
  }

  query += ' ORDER BY e.created_at ASC';

  const rows = dbSelect<PersonEmbeddingRow>(query, params);
  return rows.map(rowToPersonEmbedding);
}

/**
 * Update embedding assignment
 */
export function updateEmbedding(
  id: string,
  updates: { clusterId?: string | null; manualAssignment?: boolean }
): PersonEmbedding | null {
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

  dbRun(`UPDATE person_embeddings SET ${setClauses.join(', ')} WHERE id = ?`, params);
  log.debug({ id }, 'updated embedding');

  return getEmbeddingById(id);
}

/**
 * Delete embedding
 */
export function deleteEmbedding(id: string): void {
  dbRun('DELETE FROM person_embeddings WHERE id = ?', [id]);
  log.debug({ id }, 'deleted embedding');
}

/**
 * Delete all embeddings for a source path
 */
export function deleteEmbeddingsForSource(sourcePath: string): number {
  const result = dbRun(
    'DELETE FROM person_embeddings WHERE source_path = ?',
    [sourcePath]
  );
  log.info({ sourcePath, count: result.changes }, 'deleted embeddings for source');
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
): { cluster: PersonCluster; similarity: number } | null {
  const clusters = listAllClusters(type);
  const threshold = type === 'voice' ? VOICE_SIMILARITY_THRESHOLD : FACE_SIMILARITY_THRESHOLD;

  let bestMatch: { cluster: PersonCluster; similarity: number } | null = null;

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
  cluster: PersonCluster,
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
  cluster: PersonCluster,
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
  clusterA: PersonCluster,
  clusterB: PersonCluster
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
  input: PersonEmbeddingInput
): { embedding: PersonEmbedding; cluster: PersonCluster; person: PersonRecord; isNewPerson: boolean } {
  return dbTransaction(() => {
    const normalizedVector = l2Normalize(input.vector);

    // If manual assignment, just create the embedding without clustering
    if (input.manualAssignment) {
      const embedding = createEmbedding({
        ...input,
        vector: normalizedVector,
        manualAssignment: true,
      });
      // For manual assignments, we don't auto-cluster
      // The embedding will need to be manually assigned to a person/cluster
      throw new Error('Manual assignment requires explicit cluster/person assignment');
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

      const person = getPersonById(match.cluster.personId);
      if (!person) throw new Error('Cluster has no person');

      log.info(
        { embeddingId: embedding.id, clusterId: match.cluster.id, personId: person.id, similarity: match.similarity },
        'added embedding to existing cluster'
      );

      return { embedding, cluster: match.cluster, person, isNewPerson: false };
    } else {
      // Create new cluster and pending person
      const person = createPerson({});
      const cluster = createCluster({
        personId: person.id,
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
        { embeddingId: embedding.id, clusterId: cluster.id, personId: person.id },
        'created new cluster and pending person'
      );

      return { embedding, cluster, person, isNewPerson: true };
    }
  });
}

// =============================================================================
// MERGE & UNASSIGN OPERATIONS
// =============================================================================

/**
 * Merge two people: move all clusters from source to target, delete source
 */
export function mergePeople(targetId: string, sourceId: string): PersonRecord {
  return dbTransaction(() => {
    const target = getPersonById(targetId);
    const source = getPersonById(sourceId);

    if (!target) throw new Error(`Target person not found: ${targetId}`);
    if (!source) throw new Error(`Source person not found: ${sourceId}`);
    if (targetId === sourceId) throw new Error('Cannot merge person with itself');

    // Move all clusters from source to target
    dbRun(
      'UPDATE person_clusters SET person_id = ?, updated_at = ? WHERE person_id = ?',
      [targetId, new Date().toISOString(), sourceId]
    );

    // Delete source person
    deletePerson(sourceId);

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
      const personId = cluster.personId;
      deleteCluster(clusterId);

      // Check if person has no clusters left and is pending
      const remainingClusters = listClustersForPerson(personId);
      if (remainingClusters.length === 0) {
        const person = getPersonById(personId);
        if (person?.isPending) {
          deletePerson(personId);
          log.info({ personId }, 'deleted empty pending person');
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
 * Assign embedding to a specific person's cluster (manual assignment)
 * Creates a new cluster for the person if needed
 */
export function assignEmbeddingToPerson(
  embeddingId: string,
  personId: string
): { embedding: PersonEmbedding; cluster: PersonCluster } {
  return dbTransaction(() => {
    const embedding = getEmbeddingById(embeddingId);
    if (!embedding) throw new Error(`Embedding not found: ${embeddingId}`);

    const person = getPersonById(personId);
    if (!person) throw new Error(`Person not found: ${personId}`);

    // Find an existing cluster of the same type, or create new
    const existingClusters = listClustersForPerson(personId, embedding.type);
    let targetCluster: PersonCluster;

    if (existingClusters.length > 0) {
      // Find best matching cluster for this person
      let bestMatch: { cluster: PersonCluster; similarity: number } | null = null;

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
      // Create new cluster for this person
      targetCluster = createCluster({
        personId,
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
          const oldPersonId = oldCluster.personId;
          deleteCluster(oldCluster.id);

          // Clean up empty pending person
          const remainingClusters = listClustersForPerson(oldPersonId);
          if (remainingClusters.length === 0) {
            const oldPerson = getPersonById(oldPersonId);
            if (oldPerson?.isPending) {
              deletePerson(oldPersonId);
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

    log.info({ embeddingId, personId, clusterId: targetCluster.id }, 'assigned embedding to person');

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
        const personId = cluster.personId;
        deleteCluster(clusterId);

        // Check if person has no clusters left and is pending
        const remainingClusters = listClustersForPerson(personId);
        if (remainingClusters.length === 0) {
          const person = getPersonById(personId);
          if (person?.isPending) {
            deletePerson(personId);
            log.info({ personId, sourcePath }, 'deleted empty pending person after source deletion');
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
