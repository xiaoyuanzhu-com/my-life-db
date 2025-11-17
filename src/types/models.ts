/**
 * Central Data Models
 *
 * Single source of truth for all core data models.
 * Maps directly to SQLite schema and provides TypeScript-friendly versions.
 *
 * Convention:
 * - *Row types: snake_case, matches SQLite schema exactly
 * - Regular types: camelCase, for TypeScript usage
 */

// ============================================================================
// ENUMS & CONSTANTS
// ============================================================================

/**
 * Message Type - categorizes what kind of content the user submitted
 *
 * Values:
 * - text: Plain text only
 * - url: Web link
 * - image: Single image (no text)
 * - audio: Audio recording
 * - video: Video file
 * - pdf: PDF document
 * - mixed: Text combined with attachments
 */
export type MessageType = 'text' | 'url' | 'image' | 'audio' | 'video' | 'pdf' | 'mixed';

/**
 * Enrichment Status - tracks AI processing state for files and digests
 *
 * Lifecycle: pending → enriching → enriched (or failed/skipped)
 *
 * Values:
 * - pending: Queued for processing, not started yet
 * - enriching: Currently being processed by AI
 * - enriched: Successfully processed and enriched
 * - failed: Processing failed (see error field)
 * - skipped: Intentionally skipped (not applicable for this file)
 */
export type EnrichmentStatus = 'pending' | 'enriching' | 'enriched' | 'failed' | 'skipped';

/**
 * Digest Type - identifies what kind of AI-generated content
 *
 * Values:
 * - summary: AI-generated text summary
 * - tags: AI-generated tags (stored as JSON array)
 * - slug: URL-friendly slug + title (stored as JSON object)
 * - content-md: Extracted/crawled content in Markdown format
 * - content-html: Extracted/crawled content in HTML format (stored in SQLAR)
 * - screenshot: Screenshot image (stored in SQLAR)
 */
export type DigestType = 'summary' | 'tags' | 'slug' | 'content-md' | 'content-html' | 'screenshot';

/**
 * Task Status - tracks background job state
 *
 * Lifecycle: to-do → in-progress → success (or failed → to-do for retry)
 *
 * Values:
 * - to-do: Queued for execution
 * - in-progress: Currently executing
 * - success: Completed successfully
 * - failed: Execution failed (may be retried)
 */
export type TaskStatus = 'to-do' | 'in-progress' | 'success' | 'failed';

/**
 * File Type - broad categorization of file content
 *
 * Values:
 * - text: Text-based files (.txt, .md, etc.)
 * - image: Image files (.jpg, .png, etc.)
 * - audio: Audio files (.mp3, .wav, etc.)
 * - video: Video files (.mp4, .mov, etc.)
 * - pdf: PDF documents
 * - other: All other file types
 */
export type FileType = 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'other';

// ============================================================================
// FILES TABLE - Rebuildable cache of file metadata
// ============================================================================

/**
 * File record row (snake_case - matches SQLite schema exactly)
 *
 * The files table is a rebuildable cache tracking all files and folders
 * in DATA_ROOT for fast queries. Can be deleted and rebuilt from filesystem.
 *
 * Primary key: path (relative from DATA_ROOT)
 */
export interface FileRecordRow {
  /** Relative path from DATA_ROOT (e.g., 'inbox/photo.jpg', 'inbox/uuid-folder') */
  path: string;

  /** Filename or folder name only (no path) */
  name: string;

  /** 1 for folders, 0 for files */
  is_folder: number;

  /** File size in bytes (null for folders) */
  size: number | null;

  /** MIME type (e.g., 'image/jpeg', 'text/markdown') - null for folders */
  mime_type: string | null;

  /** SHA256 hash for files <10MB (null for large files and folders) */
  hash: string | null;

  /** ISO 8601 timestamp from file system mtime */
  modified_at: string;

  /** ISO 8601 timestamp when first indexed */
  created_at: string;

  /** ISO 8601 timestamp of last scan */
  last_scanned_at: string;
}

/**
 * File record (camelCase - for TypeScript usage)
 *
 * TypeScript-friendly version of FileRecordRow with proper types.
 */
export interface FileRecord {
  /** Relative path from DATA_ROOT (e.g., 'inbox/photo.jpg', 'inbox/uuid-folder') */
  path: string;

  /** Filename or folder name only (no path) */
  name: string;

  /** true for folders, false for files */
  isFolder: boolean;

  /** File size in bytes (null for folders) */
  size: number | null;

  /** MIME type (e.g., 'image/jpeg', 'text/markdown') - null for folders */
  mimeType: string | null;

  /** SHA256 hash for files <10MB (null for large files and folders) */
  hash: string | null;

  /** ISO 8601 timestamp from file system mtime */
  modifiedAt: string;

  /** ISO 8601 timestamp when first indexed */
  createdAt: string;

  /** ISO 8601 timestamp of last scan */
  lastScannedAt: string;
}

// ============================================================================
// DIGESTS TABLE - AI-generated content for files
// ============================================================================

/**
 * Digest record row (snake_case - matches SQLite schema exactly)
 *
 * Each file can have multiple digest types (summary, tags, slug, etc.).
 * Text content stored in 'content' field, binary content in SQLAR archive.
 *
 * Primary key: id (hash of file_path + digest_type)
 */
export interface DigestRecordRow {
  /** Digest ID (hash-based from file_path + digest_type) */
  id: string;

  /** Path to file (e.g., 'inbox/photo.jpg' or 'inbox/uuid-folder') */
  file_path: string;

  /** Type of digest (see DigestType enum) */
  digest_type: string;

  /** Processing status (see EnrichmentStatus enum) */
  status: string;

  /** Text content (summary text, JSON for tags/slug) - null for binary digests */
  content: string | null;

  /** Filename in SQLAR archive (for binary digests like screenshots) */
  sqlar_name: string | null;

  /** Error message if status='failed' */
  error: string | null;

  /** ISO 8601 timestamp when digest was created */
  created_at: string;

  /** ISO 8601 timestamp when digest was last updated */
  updated_at: string;
}

/**
 * Digest record (camelCase - for TypeScript usage)
 *
 * AI-generated content for a file. Each file can have multiple digests
 * of different types (summary, tags, slug, screenshot, etc.).
 */
export interface Digest {
  /** Digest ID (hash-based from filePath + digestType) */
  id: string;

  /** Path to file (e.g., 'inbox/photo.jpg' or 'inbox/uuid-folder') */
  filePath: string;

  /** Type of digest (see DigestType enum) */
  digestType: string;

  /** Processing status (see EnrichmentStatus enum) */
  status: EnrichmentStatus;

  /** Text content (summary text, JSON for tags/slug) - null for binary digests */
  content: string | null;

  /** Filename in SQLAR archive (for binary digests like screenshots) */
  sqlarName: string | null;

  /** Error message if status='failed' */
  error: string | null;

  /** ISO 8601 timestamp when digest was created */
  createdAt: string;

  /** ISO 8601 timestamp when digest was last updated */
  updatedAt: string;
}

// ============================================================================
// TASKS TABLE - Background job queue
// ============================================================================

/**
 * Task record row (snake_case - matches SQLite schema exactly)
 *
 * Background job queue for async operations (AI processing, indexing, etc.).
 * Workers poll this table and execute jobs based on type.
 */
export interface TaskRecordRow {
  /** Task ID (UUID) */
  id: string;

  /** Task type (e.g., 'digest_url_crawl', 'meili_index') */
  type: string;

  /** Input data (JSON string) */
  input: string;

  /** Current status (see TaskStatus enum) */
  status: string;

  /** Version number for optimistic locking */
  version: number;

  /** Number of execution attempts */
  attempts: number;

  /** Unix timestamp (ms) of last execution attempt */
  last_attempt_at: number | null;

  /** Output data (JSON string) - null until completed */
  output: string | null;

  /** Error message if status='failed' */
  error: string | null;

  /** Unix timestamp (ms) - don't execute before this time */
  run_after: number | null;

  /** Unix timestamp (ms) when task was created */
  created_at: number;

  /** Unix timestamp (ms) when task was last updated */
  updated_at: number;

  /** Unix timestamp (ms) when task completed (success or final failure) */
  completed_at: number | null;
}

/**
 * Task record (camelCase - for TypeScript usage)
 *
 * Background job with type-safe input/output and status tracking.
 */
export interface Task<TInput = unknown, TOutput = unknown> {
  /** Task ID (UUID) */
  id: string;

  /** Task type (e.g., 'digest_url_crawl', 'meili_index') */
  type: string;

  /** Input data (parsed from JSON) */
  input: TInput;

  /** Current status (see TaskStatus enum) */
  status: TaskStatus;

  /** Version number for optimistic locking */
  version: number;

  /** Number of execution attempts */
  attempts: number;

  /** Unix timestamp (ms) of last execution attempt */
  lastAttemptAt: number | null;

  /** Output data (parsed from JSON) - null until completed */
  output: TOutput | null;

  /** Error message if status='failed' */
  error: string | null;

  /** Unix timestamp (ms) - don't execute before this time */
  runAfter: number | null;

  /** Unix timestamp (ms) when task was created */
  createdAt: number;

  /** Unix timestamp (ms) when task was last updated */
  updatedAt: number;

  /** Unix timestamp (ms) when task completed (success or final failure) */
  completedAt: number | null;
}

// ============================================================================
// SETTINGS TABLE - Application configuration
// ============================================================================

/**
 * Setting record row (snake_case - matches SQLite schema exactly)
 *
 * Simple key-value store for application settings.
 */
export interface SettingRecordRow {
  /** Setting key (unique identifier) */
  key: string;

  /** Setting value (stored as string, may be JSON) */
  value: string;

  /** ISO 8601 timestamp when setting was last updated */
  updated_at: string;
}

/**
 * Setting record (camelCase - for TypeScript usage)
 */
export interface Setting {
  /** Setting key (unique identifier) */
  key: string;

  /** Setting value (stored as string, may be JSON) */
  value: string;

  /** ISO 8601 timestamp when setting was last updated */
  updatedAt: string;
}

// ============================================================================
// HELPER TYPES
// ============================================================================

/**
 * Conversion helper: FileRecordRow → FileRecord
 */
export function rowToFileRecord(row: FileRecordRow): FileRecord {
  return {
    path: row.path,
    name: row.name,
    isFolder: row.is_folder === 1,
    size: row.size,
    mimeType: row.mime_type,
    hash: row.hash,
    modifiedAt: row.modified_at,
    createdAt: row.created_at,
    lastScannedAt: row.last_scanned_at,
  };
}

/**
 * Conversion helper: DigestRecordRow → Digest
 */
export function rowToDigest(row: DigestRecordRow): Digest {
  return {
    id: row.id,
    filePath: row.file_path,
    digestType: row.digest_type,
    status: row.status as EnrichmentStatus,
    content: row.content,
    sqlarName: row.sqlar_name,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Conversion helper: TaskRecordRow → Task
 */
export function rowToTask<TInput = unknown, TOutput = unknown>(
  row: TaskRecordRow
): Task<TInput, TOutput> {
  return {
    id: row.id,
    type: row.type,
    input: JSON.parse(row.input) as TInput,
    status: row.status as TaskStatus,
    version: row.version,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    output: row.output ? (JSON.parse(row.output) as TOutput) : null,
    error: row.error,
    runAfter: row.run_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/**
 * Conversion helper: SettingRecordRow → Setting
 */
export function rowToSetting(row: SettingRecordRow): Setting {
  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
  };
}
