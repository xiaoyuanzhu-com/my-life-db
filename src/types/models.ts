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
export type { MessageType } from './models/enums/MessageType';
export type { EnrichmentStatus } from './models/enums/EnrichmentStatus';
export type { DigestType } from './models/enums/DigestType';
export type { TaskStatus } from './models/enums/TaskStatus';
export type { FileType } from './models/enums/FileType';

// Database Models - Files
export type { FileRecord, FileRecordRow } from './models/database/FileRecord';
export { rowToFileRecord } from './models/database/FileRecord';

// Database Models - Digests
export type { Digest, DigestRecordRow } from './models/database/Digest';
export { rowToDigest } from './models/database/Digest';

// Database Models - Tasks
export type { Task, TaskRecordRow } from './models/database/Task';
export { rowToTask } from './models/database/Task';

// Database Models - Settings
export type { Setting, SettingRecordRow } from './models/database/Setting';
export { rowToSetting } from './models/database/Setting';
