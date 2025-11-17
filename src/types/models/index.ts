/**
 * Core Data Models - Central export point
 *
 * All database models and enums organized by category.
 * This is the single source of truth for core data types.
 */

// ============================================================================
// ENUMS
// ============================================================================

export type { MessageType } from './enums/message-type';
export type { EnrichmentStatus } from './enums/enrichment-status';
export type { DigestType } from './enums/digest-type';
export type { TaskStatus } from './enums/task-status';
export type { FileType } from './enums/file-type';

// ============================================================================
// DATABASE MODELS
// ============================================================================

// Files Table
export type { FileRecord, FileRecordRow } from './database/file-record';
export { rowToFileRecord } from './database/file-record';

// Digests Table
export type { Digest, DigestRecordRow } from './database/digest';
export { rowToDigest } from './database/digest';

// Tasks Table
export type { Task, TaskRecordRow } from './database/task';
export { rowToTask } from './database/task';

// Settings Table
export type { Setting, SettingRecordRow } from './database/setting';
export { rowToSetting } from './database/setting';

// Meilisearch Documents Table
export type { MeiliDocument, MeiliDocumentRow, MeiliStatus } from './database/meili-document';
export { rowToMeiliDocument } from './database/meili-document';

// Qdrant Documents Table
export type { QdrantDocument, QdrantDocumentRow, EmbeddingStatus, SourceType } from './database/qdrant-document';
export { rowToQdrantDocument } from './database/qdrant-document';
