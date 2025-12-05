/**
 * Central Data Models - Re-export point
 *
 * This file re-exports all models from the models/ directory.
 * All types are now organized in individual files for better maintainability.
 *
 * Convention:
 * - *Row types: snake_case, matches SQLite schema exactly
 * - Regular types: camelCase, for TypeScript usage
 */

// Enums
export type { MessageType } from './message-type';
export type { DigestStatus } from './digest-status';
export type { TaskStatus } from './task-status';
export type { FileType } from './file-type';

// Database Models - Files
export type { FileRecord, FileRecordRow } from './file-record';
export { rowToFileRecord } from './file-record';

// Database Models - Digests
export type { Digest, DigestRecordRow, DigestInput } from './digest';
export { rowToDigest } from './digest';

// Database Models - Tasks
export type { Task, TaskRecordRow } from './task';
export { rowToTask } from './task';

// Database Models - Settings
export type { Setting, SettingRecordRow } from './setting';
export { rowToSetting } from './setting';

// Database Models - Meilisearch Documents
export type { MeiliDocument, MeiliDocumentRow, MeiliStatus } from './meili-document';
export { rowToMeiliDocument } from './meili-document';

// Database Models - Qdrant Documents
export type { QdrantDocument, QdrantDocumentRow, EmbeddingStatus, SourceType } from './qdrant-document';
export { rowToQdrantDocument } from './qdrant-document';

// Database Models - People Registry
export type { PersonRecord, PersonRecordRow, PersonInput, PersonWithCounts } from './person';
export { rowToPersonRecord } from './person';

export type { PersonCluster, PersonClusterRow, PersonClusterInput, ClusterType } from './person-cluster';
export { rowToPersonCluster, float32ArrayToBuffer } from './person-cluster';

export type {
  PersonEmbedding,
  PersonEmbeddingRow,
  PersonEmbeddingInput,
  PersonEmbeddingWithSource,
  VoiceSourceOffset,
  FaceSourceOffset,
  SourceOffset,
} from './person-embedding';
export { rowToPersonEmbedding, float32ArrayToBuffer as embeddingFloat32ArrayToBuffer } from './person-embedding';
