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
export type { TaskStatus } from './task-status';
export type { FileType } from './file-type';

// Database Models - Files
export type { FileRecord, FileRecordRow } from './file-record';
export { rowToFileRecord } from './file-record';

// Database Models - Tasks
export type { Task, TaskRecordRow } from './task';
export { rowToTask } from './task';

// Database Models - Settings
export type { Setting, SettingRecordRow } from './setting';
export { rowToSetting } from './setting';

// Database Models - People Registry
export type { PeopleRecord, PeopleRecordRow, PeopleInput, PeopleWithCounts } from './people-record';
export { rowToPeopleRecord } from './people-record';

export type { PeopleCluster, PeopleClusterRow, PeopleClusterInput, ClusterType } from './people-cluster';
export { rowToPeopleCluster, float32ArrayToBuffer } from './people-cluster';

export type {
  PeopleEmbedding,
  PeopleEmbeddingRow,
  PeopleEmbeddingInput,
  PeopleEmbeddingWithSource,
  VoiceSourceOffset,
  FaceSourceOffset,
  SourceOffset,
} from './people-embedding';
export { rowToPeopleEmbedding, float32ArrayToBuffer as embeddingFloat32ArrayToBuffer } from './people-embedding';
