/**
 * File Record - Files table models
 *
 * The files table is a rebuildable cache tracking all files and folders
 * in DATA_ROOT for fast queries. Can be deleted and rebuilt from filesystem.
 */

/**
 * File record row (snake_case - matches SQLite schema exactly)
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

  /** Text preview for text files (first ~50 lines, null for non-text files) */
  text_preview: string | null;
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

  /** Text preview for text files (first ~50 lines, null for non-text files) */
  textPreview: string | null;
}

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
    textPreview: row.text_preview,
  };
}
