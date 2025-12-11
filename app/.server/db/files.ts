/**
 * File metadata cache operations
 *
 * The files table is a rebuildable cache of file metadata.
 * It tracks all files and folders in the data directory for fast queries.
 * Can be deleted and rebuilt from filesystem at any time.
 */

import { dbRun, dbSelect, dbSelectOne } from './client';
import { getLogger } from '~/.server/log/logger';
import type { FileRecord, FileRecordRow } from '~/types/models';
import { rowToFileRecord } from '~/types/models';

// Re-export types for convenience
export type { FileRecord, FileRecordRow };

// Cursor types for pagination
export interface Cursor {
  createdAt: string;
  path: string;
}

export interface CursorPageResult {
  items: FileRecord[];
  cursors: {
    first: string | null;
    last: string | null;
  };
  hasMore: {
    older: boolean;
    newer: boolean;
  };
}

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
 * Update screenshot_sqlar cached field
 * Called by digest coordinator when a screenshot digest completes
 */
export function updateFileScreenshotSqlar(path: string, screenshotSqlar: string | null): void {
  dbRun('UPDATE files SET screenshot_sqlar = ? WHERE path = ?', [screenshotSqlar, path]);
  log.debug({ path, screenshotSqlar }, 'updated file screenshot_sqlar');
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
 * Get all file paths from database (excluding reserved folders)
 * Used for orphan detection during library scans
 */
export function getAllFilePaths(excludedPrefixes: string[] = []): string[] {
  const conditions: string[] = [];
  const params: string[] = [];

  if (excludedPrefixes.length > 0) {
    excludedPrefixes.forEach(prefix => {
      conditions.push('path NOT LIKE ?');
      params.push(`${prefix}%`);
    });
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `SELECT path FROM files ${whereClause} ORDER BY path ASC`;

  const rows = dbSelect<{ path: string }>(query, params);
  return rows.map(row => row.path);
}

/**
 * Clear all file records (for full rebuild)
 */
export function clearAllFiles(): void {
  dbRun('DELETE FROM files');
  log.info({}, 'cleared all file records');
}

/**
 * Get the position of a file in the ordered list
 * @deprecated Use cursor-based pagination instead (listTopLevelFilesAround)
 */
export function getFilePosition(
  path: string,
  pathPrefix: string = 'inbox/',
  orderBy: 'created_at' | 'modified_at' = 'created_at',
  ascending: boolean = false
): { position: number; total: number } | null {
  const file = getFileByPath(path);
  if (!file) return null;

  const operator = ascending ? '<' : '>';
  const sortValue = orderBy === 'created_at' ? file.createdAt : file.modifiedAt;

  // Count how many items come BEFORE this one in the sort order
  const query = `
    SELECT COUNT(*) as position
    FROM files
    WHERE path LIKE ?
      AND (
        ${orderBy} ${operator} ?
        OR (${orderBy} = ? AND path ${operator} ?)
      )
  `;

  const result = dbSelectOne<{ position: number }>(
    query,
    [`${pathPrefix}%`, sortValue, sortValue, path]
  );

  // Get total count
  const totalResult = dbSelectOne<{ total: number }>(
    'SELECT COUNT(*) as total FROM files WHERE path LIKE ?',
    [`${pathPrefix}%`]
  );

  return {
    position: result?.position ?? 0,
    total: totalResult?.total ?? 0,
  };
}

// =============================================================================
// Cursor-based pagination functions
// =============================================================================

/**
 * Parse cursor string into Cursor object
 * Format: "created_at:path" (e.g., "2025-01-26T10:00:00.000Z:inbox/photo.jpg")
 */
export function parseCursor(cursor: string): Cursor | null {
  // Find the first colon after the timestamp (ISO format has colons in time)
  // Format: YYYY-MM-DDTHH:MM:SS.sssZ:path
  const match = cursor.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):(.+)$/);
  if (!match) return null;

  return {
    createdAt: match[1],
    path: match[2],
  };
}

/**
 * Create cursor string from file record
 */
export function createCursor(file: { createdAt: string; path: string }): string {
  return `${file.createdAt}:${file.path}`;
}

/**
 * Build the top-level filter condition for inbox queries
 * Matches: inbox/file.jpg (no nested slash) OR inbox/folder (folder with exactly 1 slash)
 */
function buildTopLevelCondition(pathPrefix: string): { sql: string; params: (string | number)[] } {
  return {
    sql: `
      path LIKE ?
      AND (
        path NOT LIKE ?
        OR (is_folder = 1 AND LENGTH(path) - LENGTH(REPLACE(path, '/', '')) = 1)
      )
    `,
    params: [`${pathPrefix}%`, `${pathPrefix}%/%`],
  };
}

/**
 * Convert query results to CursorPageResult
 */
function toCursorPageResult(
  items: FileRecord[],
  hasOlder: boolean,
  hasNewer: boolean
): CursorPageResult {
  return {
    items,
    cursors: {
      first: items.length > 0 ? createCursor(items[0]) : null,
      last: items.length > 0 ? createCursor(items[items.length - 1]) : null,
    },
    hasMore: {
      older: hasOlder,
      newer: hasNewer,
    },
  };
}

/**
 * Load the newest page (no cursor, initial load)
 * Returns items sorted by created_at DESC, path DESC
 */
export function listTopLevelFilesNewest(
  pathPrefix: string,
  limit: number
): CursorPageResult {
  const topLevel = buildTopLevelCondition(pathPrefix);

  const query = `
    SELECT * FROM files
    WHERE ${topLevel.sql}
    ORDER BY created_at DESC, path DESC
    LIMIT ?
  `;

  const rows = dbSelect<FileRecordRow>(query, [...topLevel.params, limit + 1]);
  const hasOlder = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToFileRecord);

  // Check if there are newer items (there shouldn't be on initial load, but API supports it)
  const hasNewer = false;

  return toCursorPageResult(items, hasOlder, hasNewer);
}

/**
 * Load older items (before cursor in sort order)
 * "Before" means items that come AFTER the cursor in DESC order (older items)
 */
export function listTopLevelFilesBefore(
  pathPrefix: string,
  cursor: Cursor,
  limit: number
): CursorPageResult {
  const topLevel = buildTopLevelCondition(pathPrefix);

  // Items that sort after cursor in DESC order = older items
  // WHERE (created_at < cursor.createdAt) OR (created_at = cursor.createdAt AND path < cursor.path)
  const query = `
    SELECT * FROM files
    WHERE ${topLevel.sql}
      AND (
        created_at < ?
        OR (created_at = ? AND path < ?)
      )
    ORDER BY created_at DESC, path DESC
    LIMIT ?
  `;

  const rows = dbSelect<FileRecordRow>(query, [
    ...topLevel.params,
    cursor.createdAt,
    cursor.createdAt,
    cursor.path,
    limit + 1,
  ]);

  const hasOlder = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToFileRecord);

  // There are newer items (the cursor came from somewhere)
  const hasNewer = true;

  return toCursorPageResult(items, hasOlder, hasNewer);
}

/**
 * Load newer items (after cursor in sort order)
 * "After" means items that come BEFORE the cursor in DESC order (newer items)
 */
export function listTopLevelFilesAfter(
  pathPrefix: string,
  cursor: Cursor,
  limit: number
): CursorPageResult {
  const topLevel = buildTopLevelCondition(pathPrefix);

  // Items that sort before cursor in DESC order = newer items
  // Query in ASC order and reverse results
  // WHERE (created_at > cursor.createdAt) OR (created_at = cursor.createdAt AND path > cursor.path)
  const query = `
    SELECT * FROM files
    WHERE ${topLevel.sql}
      AND (
        created_at > ?
        OR (created_at = ? AND path > ?)
      )
    ORDER BY created_at ASC, path ASC
    LIMIT ?
  `;

  const rows = dbSelect<FileRecordRow>(query, [
    ...topLevel.params,
    cursor.createdAt,
    cursor.createdAt,
    cursor.path,
    limit + 1,
  ]);

  const hasNewer = rows.length > limit;
  // Reverse to get DESC order (newest first in batch)
  const items = rows.slice(0, limit).reverse().map(rowToFileRecord);

  // There are older items (the cursor came from somewhere)
  const hasOlder = true;

  return toCursorPageResult(items, hasOlder, hasNewer);
}

/**
 * Load page containing a specific cursor (for pin navigation)
 * Centers the target item in the result, loading items before and after
 */
export function listTopLevelFilesAround(
  pathPrefix: string,
  cursor: Cursor,
  limit: number
): CursorPageResult & { targetIndex: number } {
  const topLevel = buildTopLevelCondition(pathPrefix);
  const halfLimit = Math.floor(limit / 2);

  // Load items BEFORE cursor (older, including cursor item)
  const beforeQuery = `
    SELECT * FROM files
    WHERE ${topLevel.sql}
      AND (
        created_at < ?
        OR (created_at = ? AND path <= ?)
      )
    ORDER BY created_at DESC, path DESC
    LIMIT ?
  `;

  const beforeRows = dbSelect<FileRecordRow>(beforeQuery, [
    ...topLevel.params,
    cursor.createdAt,
    cursor.createdAt,
    cursor.path,
    halfLimit + 1,
  ]);

  // Load items AFTER cursor (newer, excluding cursor item)
  const afterQuery = `
    SELECT * FROM files
    WHERE ${topLevel.sql}
      AND (
        created_at > ?
        OR (created_at = ? AND path > ?)
      )
    ORDER BY created_at ASC, path ASC
    LIMIT ?
  `;

  const afterRows = dbSelect<FileRecordRow>(afterQuery, [
    ...topLevel.params,
    cursor.createdAt,
    cursor.createdAt,
    cursor.path,
    halfLimit + 1,
  ]);

  // Determine hasMore
  const hasOlder = beforeRows.length > halfLimit;
  const hasNewer = afterRows.length > halfLimit;

  // Combine: newer items (reversed to DESC) + cursor item + older items
  const newerItems = afterRows.slice(0, halfLimit).reverse().map(rowToFileRecord);
  const olderItems = beforeRows.slice(0, halfLimit).map(rowToFileRecord);

  // Combined order: newest first (newerItems), then olderItems
  const items = [...newerItems, ...olderItems];

  // Find target index (the cursor item should be at the junction)
  // The target is the first item in olderItems (or last in the combined if no older)
  const targetIndex = newerItems.length;

  return {
    ...toCursorPageResult(items, hasOlder, hasNewer),
    targetIndex,
  };
}

/**
 * Get cursor for a file by path
 * Useful for getting cursor from pinned items
 */
export function getCursorForPath(path: string): string | null {
  const file = getFileByPath(path);
  if (!file) return null;
  return createCursor(file);
}
