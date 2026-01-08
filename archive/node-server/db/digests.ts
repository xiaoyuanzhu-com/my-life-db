// Database operations for digests table
import { randomUUID } from 'crypto';
import { dbRun, dbSelect, dbSelectOne } from './client';
import { getLogger } from '~/.server/log/logger';
import type { Digest, DigestRecordRow } from '~/types';

const log = getLogger({ module: 'DBDigests' });

function formatStack(maxLines: number = 5): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  return stack
    .split('\n')
    .slice(2, 2 + maxLines)
    .map(line => line.trim())
    .join(' | ');
}

/**
 * Create a new digest in the database
 */
export function createDigest(digest: Digest): void {
  dbRun(
    `
      INSERT INTO digests (
        id, file_path, digester, status, content, sqlar_name, error,
        attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path,
        digester = excluded.digester,
        status = excluded.status,
        content = excluded.content,
        sqlar_name = excluded.sqlar_name,
        error = excluded.error,
        attempts = excluded.attempts,
        updated_at = excluded.updated_at
    `,
    [
      digest.id,
      digest.filePath,
      digest.digester,
      digest.status,
      digest.content,
      digest.sqlarName,
      digest.error,
      digest.attempts ?? 0,
      digest.createdAt,
      digest.updatedAt,
    ]
  );

  if (digest.status === 'todo') {
    log.debug(
      { filePath: digest.filePath, digester: digest.digester, attempts: digest.attempts ?? 0, stack: formatStack() },
      'createDigest set status=todo'
    );
  }
}

/**
 * Create or reset a digest to pending status (for enqueue operations)
 * If digest exists, resets it to pending state. If not, creates it.
 */
export function upsertPendingDigest(digest: Omit<Digest, 'updatedAt'>): void {
  const now = new Date().toISOString();
  dbRun(
    `
      INSERT INTO digests (
        id, file_path, digester, status, content, sqlar_name, error,
        attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = 'todo',
        error = NULL,
        attempts = 0,
        updated_at = ?
    `,
    [
      digest.id,
      digest.filePath,
      digest.digester,
      digest.status,
      digest.content,
      digest.sqlarName,
      digest.error,
      0,
      digest.createdAt,
      now,
      now,
    ]
  );

  log.debug(
    { filePath: digest.filePath, digester: digest.digester, attempts: 0, stack: formatStack() },
    'upsertPendingDigest set status=todo'
  );
}

/**
 * Insert a digest only if it does not exist.
 * Used by sync routines to avoid overwriting existing statuses.
 */
export function insertDigestIfMissing(digest: Digest): void {
  const result = dbRun(
    `
      INSERT OR IGNORE INTO digests (
        id, file_path, digester, status, content, sqlar_name, error,
        attempts, created_at, updated_at
      ) VALUES (
        COALESCE(?, ?), ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `,
    [
      digest.id,
      digest.id ?? randomUUID(),
      digest.filePath,
      digest.digester,
      digest.status,
      digest.content,
      digest.sqlarName,
      digest.error,
      digest.attempts ?? 0,
      digest.createdAt,
      digest.updatedAt,
    ]
  );

  if (result.changes === 0) {
    log.debug(
      { filePath: digest.filePath, digester: digest.digester },
      'insertDigestIfMissing skipped existing digest'
    );
  } else if (digest.status === 'todo') {
    log.debug(
      { filePath: digest.filePath, digester: digest.digester, attempts: digest.attempts ?? 0, stack: formatStack() },
      'insertDigestIfMissing set status=todo'
    );
  }
}

/**
 * Get a digest by ID
 */
export function getDigestById(id: string): Digest | null {
  const row = dbSelectOne<DigestRecordRow>('SELECT * FROM digests WHERE id = ?', [id]);

  if (!row) return null;

  return rowToDigest(row);
}

/**
 * Get a digest by file path and digester name
 */
export function getDigestByPathAndDigester(filePath: string, digester: string): Digest | null {
  const row = dbSelectOne<DigestRecordRow>(
    'SELECT * FROM digests WHERE file_path = ? AND digester = ?',
    [filePath, digester]
  );

  if (!row) return null;

  return rowToDigest(row);
}

/**
 * List all digests for a file
 */
export function listDigestsForPath(
  filePath: string,
  options?: {
    digesters?: string[];  // Only include these digesters
    excludeDigesters?: string[];  // Exclude these digesters
    statuses?: Digest['status'][];
    excludeStatuses?: Digest['status'][];
    order?: 'asc' | 'desc';
  }
): Digest[] {
  let sql = 'SELECT * FROM digests WHERE file_path = ?';
  const params: (string | number)[] = [filePath];

  if (options?.digesters && options.digesters.length > 0) {
    const placeholders = options.digesters.map(() => '?').join(', ');
    sql += ` AND digester IN (${placeholders})`;
    params.push(...options.digesters);
  }

  if (options?.excludeDigesters && options.excludeDigesters.length > 0) {
    const placeholders = options.excludeDigesters.map(() => '?').join(', ');
    sql += ` AND digester NOT IN (${placeholders})`;
    params.push(...options.excludeDigesters);
  }

  if (options?.statuses && options.statuses.length > 0) {
    const placeholders = options.statuses.map(() => '?').join(', ');
    sql += ` AND status IN (${placeholders})`;
    params.push(...options.statuses);
  }

  if (options?.excludeStatuses && options.excludeStatuses.length > 0) {
    const placeholders = options.excludeStatuses.map(() => '?').join(', ');
    sql += ` AND status NOT IN (${placeholders})`;
    params.push(...options.excludeStatuses);
  }

  const orderDirection = options?.order === 'asc' ? 'ASC' : 'DESC';
  sql += ` ORDER BY created_at ${orderDirection}, id ${orderDirection}`;

  const rows = dbSelect<DigestRecordRow>(sql, params);

  return rows.map(rowToDigest);
}

/**
 * List digests by digester name (across all files)
 */
export function listDigestsByDigester(digester: string, limit?: number): Digest[] {
  let sql = 'SELECT * FROM digests WHERE digester = ? ORDER BY created_at DESC';
  const params: (string | number)[] = [digester];

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const rows = dbSelect<DigestRecordRow>(sql, params);

  return rows.map(rowToDigest);
}

/**
 * Update a digest
 */
export function updateDigest(
  id: string,
  updates: Partial<Omit<Digest, 'id' | 'filePath' | 'createdAt'>>
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.digester !== undefined) {
    fields.push('digester = ?');
    values.push(updates.digester);
  }

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (updates.content !== undefined) {
    fields.push('content = ?');
    values.push(updates.content);
  }

  if (updates.sqlarName !== undefined) {
    fields.push('sqlar_name = ?');
    values.push(updates.sqlarName);
  }

  if (updates.error !== undefined) {
    fields.push('error = ?');
    values.push(updates.error);
  }

  if (updates.attempts !== undefined) {
    fields.push('attempts = ?');
    values.push(updates.attempts);
  }

  // Always update updated_at
  fields.push('updated_at = ?');
  values.push(updates.updatedAt ?? new Date().toISOString());

  values.push(id);

  const sql = `UPDATE digests SET ${fields.join(', ')} WHERE id = ?`;
  dbRun(sql, values);
}

/**
 * Delete a digest by ID
 */
export function deleteDigest(id: string): void {
  dbRun('DELETE FROM digests WHERE id = ?', [id]);
}

/**
 * Delete a specific digest by file path and digester
 */
export function deleteDigestByPathAndDigester(filePath: string, digester: string): void {
  const result = dbRun('DELETE FROM digests WHERE file_path = ? AND digester = ?', [filePath, digester]);
  if (result.changes > 0) {
    log.warn(
      { filePath, digester, removed: result.changes, stack: formatStack() },
      'deleted digest by path+digester'
    );
  }
}

/**
 * Delete all digests for a file path
 */
export function deleteDigestsForPath(filePath: string): number {
  const result = dbRun('DELETE FROM digests WHERE file_path = ?', [filePath]);
  if (result.changes > 0) {
    log.warn(
      { filePath, removed: result.changes, stack: formatStack() },
      'deleted digests for path'
    );
  }
  return result.changes;
}

/**
 * Delete all digests matching path prefix (for folder deletions)
 */
export function deleteDigestsByPrefix(pathPrefix: string): number {
  const result = dbRun('DELETE FROM digests WHERE file_path LIKE ?', [`${pathPrefix}%`]);
  if (result.changes > 0) {
    log.warn(
      { pathPrefix, removed: result.changes, stack: formatStack() },
      'deleted digests by prefix'
    );
  }
  return result.changes;
}

/**
 * Update all digest file paths (for folder renames)
 */
export function updateDigestPaths(oldPath: string, newPath: string): void {
  dbRun('UPDATE digests SET file_path = ? WHERE file_path = ?', [newPath, oldPath]);
}

/**
 * Check if a digest exists for a file path and digester
 */
export function digestExists(filePath: string, digester: string): boolean {
  const row = dbSelectOne('SELECT 1 FROM digests WHERE file_path = ? AND digester = ? LIMIT 1', [
    filePath,
    digester,
  ]);

  return row !== undefined;
}

/**
 * Start a digest (create with todo status)
 * This is the preferred way to initiate digest processing
 */
export function startDigest(filePath: string, digester: string): Digest {
  const existing = getDigestByPathAndDigester(filePath, digester);
  const now = new Date().toISOString();

  const digest: Digest = {
    id: existing?.id ?? randomUUID(),
    filePath,
    digester,
    status: 'todo',
    content: null,
    sqlarName: null,
    error: null,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };

  upsertPendingDigest(digest);
  return digest;
}

/**
 * Generate a digest ID from file path and digester name
 * Format: {hash(filePath)}-{digester}
 */
export function generateDigestId(filePath: string, digester: string): string {
  const existing = getDigestByPathAndDigester(filePath, digester);
  return existing?.id ?? randomUUID();
}

/**
 * List files that need digestion based on digest statuses and attempts
 */
export function listFilesNeedingDigestion(options: {
  digesterNames: string[];
  excludedPathPrefixes?: string[];
  statuses?: Digest['status'][];
  maxAttempts?: number;
  limit?: number;
}): string[] {
  const {
    digesterNames,
    excludedPathPrefixes = [],
    statuses = ['todo', 'failed'],
    maxAttempts = Number.MAX_SAFE_INTEGER,
    limit = 100,
  } = options;

  if (digesterNames.length === 0) {
    return [];
  }

  const exclusionClause = excludedPathPrefixes.map(() => 'f.path NOT LIKE ?').join(' AND ');
  const exclusionArgs = excludedPathPrefixes.map(prefix => `${prefix}%`);
  const digesterPlaceholders = digesterNames.map(() => '?').join(', ');
  const statusPlaceholders = statuses.map(() => '?').join(', ');

  const sql = `
    SELECT d.file_path
    FROM digests d
    JOIN files f ON f.path = d.file_path
    WHERE f.is_folder = 0
      ${exclusionClause ? `AND ${exclusionClause}` : ''}
      AND d.digester IN (${digesterPlaceholders})
      AND d.status IN (${statusPlaceholders})
      AND COALESCE(d.attempts, 0) < ?
      AND d.file_path NOT IN (
        SELECT file_path FROM digests WHERE status = 'in-progress'
      )
    GROUP BY d.file_path
    ORDER BY COALESCE(f.last_scanned_at, f.created_at) ASC
    LIMIT ?
  `;

  const rows = dbSelect<{ file_path: string }>(sql, [
    ...exclusionArgs,
    ...digesterNames,
    ...statuses,
    maxAttempts,
    limit,
  ]);

  return rows.map(row => row.file_path);
}

/**
 * Reset stale in-progress digests back to todo
 */
export function resetStaleInProgressDigests(cutoffIso: string): number {
  const result = dbRun(
    `
      UPDATE digests
      SET status = 'todo', error = NULL
      WHERE status = 'in-progress'
        AND updated_at < ?
    `,
    [cutoffIso]
  );

  return result.changes ?? 0;
}

/**
 * Aggregate digest stats for API responses
 */
export function getDigestStats(): {
  totalFiles: number;
  digestedFiles: number;
  pendingDigests: number;
} {
  const totalFiles = dbSelectOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM files
     WHERE is_folder = 0
     AND path NOT LIKE 'app/%'`
  );

  const digestedFiles = dbSelectOne<{ count: number }>(
    `SELECT COUNT(DISTINCT file_path) as count FROM digests
     WHERE status = 'completed'
     AND file_path NOT LIKE 'app/%'`
  );

  const pendingDigests = dbSelectOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM digests
     WHERE status IN ('todo', 'in-progress')
     AND file_path NOT LIKE 'app/%'`
  );

  return {
    totalFiles: totalFiles?.count ?? 0,
    digestedFiles: digestedFiles?.count ?? 0,
    pendingDigests: pendingDigests?.count ?? 0,
  };
}

/**
 * Convert database record to Digest
 */
function rowToDigest(record: DigestRecordRow): Digest {
  return {
    id: record.id,
    filePath: record.file_path,
    digester: record.digester,
    status: record.status as Digest['status'],
    content: record.content,
    sqlarName: record.sqlar_name,
    error: record.error,
    attempts: record.attempts ?? 0,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
