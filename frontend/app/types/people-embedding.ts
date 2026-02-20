/**
 * People Embedding - people_embeddings table models
 *
 * Stores biometric vectors extracted from media files.
 * Each embedding links back to its source file and optionally to a cluster.
 */

import type { ClusterType } from './people-cluster';

/**
 * Voice source offset - segments for this speaker in an audio file
 */
export interface VoiceSourceOffset {
  segments: Array<{
    start: number;
    end: number;
    text?: string;
  }>;
}

/**
 * Face source offset - frame and bounding box in photo/video
 */
export interface FaceSourceOffset {
  frame: number;
  bbox: [number, number, number, number]; // [x, y, w, h]
}

/**
 * Union type for source offset
 */
export type SourceOffset = VoiceSourceOffset | FaceSourceOffset;

/**
 * People embedding row (snake_case - matches SQLite schema exactly)
 *
 * Primary key: id (UUID)
 */
export interface PeopleEmbeddingRow {
  /** UUID for primary key */
  id: string;

  /** Parent cluster (FK to people_clusters.id, nullable) */
  cluster_id: string | null;

  /** Type of embedding: 'voice' or 'face' */
  type: ClusterType;

  /** Embedding vector (Float32Array stored as BLOB) */
  vector: Buffer;

  /** File that produced this embedding (FK to files.path) */
  source_path: string;

  /** JSON string with offset info (timestamps for voice, bbox for face) */
  source_offset: string | null;

  /** Quality metric: duration for voice, face size for face */
  quality: number | null;

  /** If TRUE, skip in auto-clustering */
  manual_assignment: number;

  /** Epoch ms timestamp when created */
  created_at: number;
}

/**
 * People embedding (camelCase - for TypeScript usage)
 */
export interface PeopleEmbedding {
  /** UUID for primary key */
  id: string;

  /** Parent cluster (nullable) */
  clusterId: string | null;

  /** Type of embedding: 'voice' or 'face' */
  type: ClusterType;

  /** Embedding vector as Float32Array */
  vector: Float32Array;

  /** File that produced this embedding */
  sourcePath: string;

  /** Offset info (timestamps for voice, bbox for face) */
  sourceOffset: SourceOffset | null;

  /** Quality metric: duration for voice, face size for face */
  quality: number | null;

  /** If true, skip in auto-clustering */
  manualAssignment: boolean;

  /** Epoch ms timestamp when created */
  createdAt: number;
}

/**
 * Convert Buffer to Float32Array for vector
 */
function bufferToFloat32Array(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

/**
 * Convert Float32Array to Buffer for storage
 */
export function float32ArrayToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Conversion helper: PeopleEmbeddingRow → PeopleEmbedding
 */
export function rowToPeopleEmbedding(row: PeopleEmbeddingRow): PeopleEmbedding {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    type: row.type,
    vector: bufferToFloat32Array(row.vector),
    sourcePath: row.source_path,
    sourceOffset: row.source_offset ? JSON.parse(row.source_offset) : null,
    quality: row.quality,
    manualAssignment: row.manual_assignment === 1,
    createdAt: row.created_at,
  };
}

/**
 * Input for creating a new embedding
 */
export interface PeopleEmbeddingInput {
  id?: string;
  clusterId?: string | null;
  type: ClusterType;
  vector: Float32Array;
  sourcePath: string;
  sourceOffset?: SourceOffset | null;
  quality?: number | null;
  manualAssignment?: boolean;
}

/**
 * Embedding with additional info for UI display
 */
export interface PeopleEmbeddingWithSource extends PeopleEmbedding {
  /** Filename from source path */
  fileName: string;
}
