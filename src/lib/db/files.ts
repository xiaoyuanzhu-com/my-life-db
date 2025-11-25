/**
 * File metadata cache operations
 *
 * The files table is a rebuildable cache of file metadata.
 * It tracks all files and folders in the data directory for fast queries.
 * Can be deleted and rebuilt from filesystem at any time.
 */

import { dbRun, dbSelect, dbSelectOne } from './client';
import { getLogger } from '@/lib/log/logger';
import type { FileRecord, FileRecordRow } from '@/types/models';
import { rowToFileRecord } from '@/types/models';

// Re-export types for convenience
export type { FileRecord, FileRecordRow };

const log = getLogger({ module: 'DBFiles' });

/**
 * Get file record by path
 */
export function getFileByPath(path: string): FileRecord | null {
  const row = dbSelectOne<FileRecordRow>('SELECT * FROM files WHERE path = ?', [path]);

  return row ? rowToFileRecord(row) : null;
}

/**
 * List non-folder file paths while excluding specific path prefixes
 */
export function listFilePathsForDigestion(excludedPathPrefixes: string[] = []): string[] {
  const exclusionClause = excludedPathPrefixes.map(() => 'path NOT LIKE ?').join(' AND ');
  const exclusionArgs = excludedPathPrefixes.map(prefix => `${prefix}%`);
  const where = exclusionClause ? `AND ${exclusionClause}` : '';

  const rows = dbSelect<{ path: string }>(
    `SELECT path FROM files WHERE is_folder = 0 ${where}`,
    exclusionArgs
  );

  return rows.map(row => row.path);
}

/**
 * List files matching path prefix
 *
 * @param pathPrefix - Path prefix to filter by (e.g., "inbox/", "notes/")
 * @param options - Query options
 */
export function listFiles(
  pathPrefix?: string,
  options?: {
    isFolder?: boolean;
    orderBy?: 'path' | 'modified_at' | 'created_at';
    ascending?: boolean;
    limit?: number;
    offset?: number;
  }
): FileRecord[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (pathPrefix) {
    conditions.push('path LIKE ?');
    params.push(`${pathPrefix}%`);
  }

  if (options?.isFolder !== undefined) {
    conditions.push('is_folder = ?');
    params.push(options.isFolder ? 1 : 0);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = options?.orderBy || 'path';
  const ascending = options?.ascending !== false;
  const orderClause = `ORDER BY ${orderBy} ${ascending ? 'ASC' : 'DESC'}`;
  const limitClause = options?.limit ? `LIMIT ${options.limit}` : '';
  const offsetClause = options?.offset ? `OFFSET ${options.offset}` : '';

  const query = `
    SELECT * FROM files
    ${whereClause}
    ${orderClause}
    ${limitClause}
    ${offsetClause}
  `;

  const rows = dbSelect<FileRecordRow>(query, params);
  return rows.map(rowToFileRecord);
}

/**
 * List top-level files in a directory (e.g., inbox/file.jpg or inbox/folder, NOT inbox/folder/nested.jpg)
 * Optimized SQL-based filtering instead of loading all files and filtering in JavaScript
 *
 * @param pathPrefix - Path prefix (e.g., "inbox/")
 * @param options - Query options
 */
export function listTopLevelFiles(
  pathPrefix: string,
  options?: {
    orderBy?: 'path' | 'modified_at' | 'created_at';
    ascending?: boolean;
    limit?: number;
    offset?: number;
  }
): FileRecord[] {
  const params: (string | number)[] = [];

  // Match files like "inbox/file.jpg" (no slash after prefix)
  // OR folders like "inbox/folder" (exactly one slash after removing prefix)
  // This uses SQL to filter instead of loading everything into memory
  const conditions = [
    'path LIKE ?',
    // Top-level: path after prefix has no slashes, OR is a folder with exactly one segment
    `(
      path NOT LIKE ?
      OR (is_folder = 1 AND LENGTH(path) - LENGTH(REPLACE(path, '/', '')) = 1)
    )`
  ];

  params.push(`${pathPrefix}%`);  // Match prefix
  params.push(`${pathPrefix}%/%`);  // Has slash after prefix

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const orderBy = options?.orderBy || 'path';
  const ascending = options?.ascending !== false;
  const orderClause = `ORDER BY ${orderBy} ${ascending ? 'ASC' : 'DESC'}`;
  const limitClause = options?.limit ? `LIMIT ${options.limit}` : '';
  const offsetClause = options?.offset ? `OFFSET ${options.offset}` : '';

  const query = `
    SELECT * FROM files
    ${whereClause}
    ${orderClause}
    ${limitClause}
    ${offsetClause}
  `;

  const rows = dbSelect<FileRecordRow>(query, params);
  return rows.map(rowToFileRecord);
}

/**
 * Count top-level files in a directory
 */
export function countTopLevelFiles(pathPrefix: string): number {
  const query = `
    SELECT COUNT(*) as count FROM files
    WHERE path LIKE ?
    AND (
      path NOT LIKE ?
      OR (is_folder = 1 AND LENGTH(path) - LENGTH(REPLACE(path, '/', '')) = 1)
    )
  `;

  const row = dbSelectOne<{ count: number }>(
    query,
    [`${pathPrefix}%`, `${pathPrefix}%/%`]
  );

  return row?.count ?? 0;
}

/**
 * Create or update file record
 */
export function upsertFileRecord(file: {
  path: string;
  name: string;
  isFolder: boolean;
  size?: number | null;
  mimeType?: string | null;
  hash?: string | null;
  modifiedAt: string;
  textPreview?: string | null;
}): FileRecord {
  const now = new Date().toISOString();

  const existing = getFileByPath(file.path);

  if (existing) {
    // Update existing record
    dbRun(
      `UPDATE files SET
        name = ?,
        is_folder = ?,
        size = ?,
        mime_type = ?,
        hash = ?,
        modified_at = ?,
        last_scanned_at = ?,
        text_preview = ?
      WHERE path = ?`,
      [
        file.name,
        file.isFolder ? 1 : 0,
        file.size ?? null,
        file.mimeType ?? null,
        file.hash ?? null,
        file.modifiedAt,
        now,
        file.textPreview ?? null,
        file.path,
      ]
    );

    log.debug({ path: file.path }, 'updated file record');
  } else {
    // Insert new record
    dbRun(
      `INSERT INTO files (
        path, name, is_folder, size, mime_type, hash,
        modified_at, created_at, last_scanned_at, text_preview
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        file.path,
        file.name,
        file.isFolder ? 1 : 0,
        file.size ?? null,
        file.mimeType ?? null,
        file.hash ?? null,
        file.modifiedAt,
        now,
        now,
        file.textPreview ?? null,
      ]
    );

    log.debug({ path: file.path }, 'created file record');
  }

  return getFileByPath(file.path)!;
}

/**
 * Update file path (for renames)
 */
export function updateFilePath(oldPath: string, newPath: string): void {
  dbRun('UPDATE files SET path = ?, name = ? WHERE path = ?', [
    newPath,
    newPath.split('/').pop()!,
    oldPath,
  ]);

  log.info({ oldPath, newPath }, 'updated file path');
}

/**
 * Delete file record
 */
export function deleteFileRecord(path: string): void {
  dbRun('DELETE FROM files WHERE path = ?', [path]);
  log.debug({ path }, 'deleted file record');
}

/**
 * Delete all file records matching path prefix
 */
export function deleteFilesByPrefix(pathPrefix: string): void {
  const result = dbRun('DELETE FROM files WHERE path LIKE ?', [`${pathPrefix}%`]);
  log.info({ pathPrefix, deleted: result.changes }, 'deleted files by prefix');
}

/**
 * Count files matching path prefix
 */
export function countFiles(pathPrefix?: string, isFolder?: boolean): number {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (pathPrefix) {
    conditions.push('path LIKE ?');
    params.push(`${pathPrefix}%`);
  }

  if (isFolder !== undefined) {
    conditions.push('is_folder = ?');
    params.push(isFolder ? 1 : 0);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `SELECT COUNT(*) as count FROM files ${whereClause}`;

  const row = dbSelectOne<{ count: number }>(query, params);
  return row?.count ?? 0;
}

/**
 * Clear all file records (for full rebuild)
 */
export function clearAllFiles(): void {
  dbRun('DELETE FROM files');
  log.info({}, 'cleared all file records');
}
