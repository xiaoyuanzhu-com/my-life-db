/**
 * People Cluster - people_clusters table models
 *
 * Persistent grouping of embeddings. Each cluster always belongs to a people entry
 * (either pending or identified). A people entry can have multiple clusters of
 * the same type to capture variation.
 */

/**
 * Cluster type - voice or face
 */
export type ClusterType = 'voice' | 'face';

/**
 * People cluster row (snake_case - matches SQLite schema exactly)
 *
 * Primary key: id (UUID)
 */
export interface PeopleClusterRow {
  /** UUID for primary key */
  id: string;

  /** People entry this cluster belongs to (FK to people.id) */
  person_id: string;

  /** Type of cluster: 'voice' or 'face' */
  type: ClusterType;

  /** Average embedding vector (Float32Array stored as BLOB) */
  centroid: Buffer | null;

  /** Number of embeddings in this cluster */
  sample_count: number;

  /** ISO 8601 timestamp when created */
  created_at: string;

  /** ISO 8601 timestamp when last updated */
  updated_at: string;
}

/**
 * People cluster (camelCase - for TypeScript usage)
 */
export interface PeopleCluster {
  /** UUID for primary key */
  id: string;

  /** People entry this cluster belongs to */
  peopleId: string;

  /** Type of cluster: 'voice' or 'face' */
  type: ClusterType;

  /** Average embedding vector as Float32Array */
  centroid: Float32Array | null;

  /** Number of embeddings in this cluster */
  sampleCount: number;

  /** ISO 8601 timestamp when created */
  createdAt: string;

  /** ISO 8601 timestamp when last updated */
  updatedAt: string;
}

/**
 * Convert Buffer to Float32Array for centroid
 */
function bufferToFloat32Array(buffer: Buffer | null): Float32Array | null {
  if (!buffer) return null;
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

/**
 * Convert Float32Array to Buffer for storage
 */
export function float32ArrayToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Conversion helper: PeopleClusterRow → PeopleCluster
 */
export function rowToPeopleCluster(row: PeopleClusterRow): PeopleCluster {
  return {
    id: row.id,
    peopleId: row.person_id,
    type: row.type,
    centroid: bufferToFloat32Array(row.centroid),
    sampleCount: row.sample_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Input for creating a new cluster
 */
export interface PeopleClusterInput {
  id?: string;
  peopleId: string;
  type: ClusterType;
  centroid?: Float32Array | null;
  sampleCount?: number;
}
