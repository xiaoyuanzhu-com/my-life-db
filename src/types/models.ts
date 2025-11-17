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
export type { MessageType } from './models/enums/message-type';
export type { EnrichmentStatus } from './models/enums/enrichment-status';
export type { DigestType } from './models/enums/digest-type';
export type { TaskStatus } from './models/enums/task-status';
export type { FileType } from './models/enums/file-type';

// Database Models - Files
export type { FileRecord, FileRecordRow } from './models/database/file-record';
export { rowToFileRecord } from './models/database/file-record';

// Database Models - Digests
export type { Digest, DigestRecordRow } from './models/database/digest';
export { rowToDigest } from './models/database/digest';

// Database Models - Tasks
export type { Task, TaskRecordRow } from './models/database/task';
export { rowToTask } from './models/database/task';

// Database Models - Settings
export type { Setting, SettingRecordRow } from './models/database/setting';
export { rowToSetting } from './models/database/setting';

// Database Models - Meilisearch Documents
export type { MeiliDocument, MeiliDocumentRow, MeiliStatus } from './models/database/meili-document';
export { rowToMeiliDocument } from './models/database/meili-document';

// Database Models - Qdrant Documents
export type { QdrantDocument, QdrantDocumentRow, EmbeddingStatus, SourceType } from './models/database/qdrant-document';
export { rowToQdrantDocument } from './models/database/qdrant-document';
