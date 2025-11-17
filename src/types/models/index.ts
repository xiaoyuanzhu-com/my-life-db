/**
 * Core Data Models - Central export point
 *
 * All database models and enums organized by category.
 * This is the single source of truth for core data types.
 */

// ============================================================================
// ENUMS
// ============================================================================

export type { MessageType } from './enums/MessageType';
export type { EnrichmentStatus } from './enums/EnrichmentStatus';
export type { DigestType } from './enums/DigestType';
export type { TaskStatus } from './enums/TaskStatus';
export type { FileType } from './enums/FileType';

// ============================================================================
// DATABASE MODELS
// ============================================================================

// Files Table
export type { FileRecord, FileRecordRow } from './database/FileRecord';
export { rowToFileRecord } from './database/FileRecord';

// Digests Table
export type { Digest, DigestRecordRow } from './database/Digest';
export { rowToDigest } from './database/Digest';

// Tasks Table
export type { Task, TaskRecordRow } from './database/Task';
export { rowToTask } from './database/Task';

// Settings Table
export type { Setting, SettingRecordRow } from './database/Setting';
export { rowToSetting } from './database/Setting';
