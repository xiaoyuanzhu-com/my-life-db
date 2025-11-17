// Database operations for digests table
import { getDatabase } from './connection';
import type { Digest, DigestRecordRow } from '@/types';

/**
 * Create a new digest in the database
 */
export function createDigest(digest: Digest): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO digests (
      id, file_path, digester, status, content, sqlar_name, error,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    digest.id,
    digest.filePath,
    digest.digester,
    digest.status,
    digest.content,
    digest.sqlarName,
    digest.error,
    digest.createdAt,
    digest.updatedAt
  );
}

/**
 * Create or reset a digest to pending status (for enqueue operations)
 * If digest exists, resets it to pending state. If not, creates it.
 */
export function upsertPendingDigest(digest: Omit<Digest, 'updatedAt'>): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO digests (
      id, file_path, digester, status, content, sqlar_name, error,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = 'todo',
      error = NULL,
      updated_at = ?
  `);

  const now = new Date().toISOString();
  stmt.run(
    digest.id,
    digest.filePath,
    digest.digester,
    digest.status,
    digest.content,
    digest.sqlarName,
    digest.error,
    digest.createdAt,
    now,
    now  // updated_at for the UPDATE clause
  );
}

/**
 * Get a digest by ID
 */
export function getDigestById(id: string): Digest | null {
  const db = getDatabase();

  const row = db
    .prepare('SELECT * FROM digests WHERE id = ?')
    .get(id) as DigestRecordRow | undefined;

  if (!row) return null;

  return rowToDigest(row);
}

/**
 * Get a digest by file path and digester name
 */
export function getDigestByPathAndDigester(filePath: string, digester: string): Digest | null {
  const db = getDatabase();

  const row = db
    .prepare('SELECT * FROM digests WHERE file_path = ? AND digester = ?')
    .get(filePath, digester) as DigestRecordRow | undefined;

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
  }
): Digest[] {
  const db = getDatabase();

  let sql = 'SELECT * FROM digests WHERE file_path = ?';
  const params: (string | string[])[] = [filePath];

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

  sql += ' ORDER BY created_at DESC';

  const rows = db
    .prepare(sql)
    .all(...params) as DigestRecordRow[];

  return rows.map(rowToDigest);
}

/**
 * List digests by digester name (across all files)
 */
export function listDigestsByDigester(digester: string, limit?: number): Digest[] {
  const db = getDatabase();

  let sql = 'SELECT * FROM digests WHERE digester = ? ORDER BY created_at DESC';
  const params: (string | number)[] = [digester];

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const rows = db.prepare(sql).all(...params) as DigestRecordRow[];

  return rows.map(rowToDigest);
}

/**
 * Update a digest
 */
export function updateDigest(
  id: string,
  updates: Partial<Omit<Digest, 'id' | 'filePath' | 'createdAt'>>
): void {
  const db = getDatabase();

  const fields: string[] = [];
  const values: (string | null)[] = [];

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

  // Always update updated_at
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());

  values.push(id);

  const sql = `UPDATE digests SET ${fields.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...values);
}

/**
 * Delete a digest by ID
 */
export function deleteDigest(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM digests WHERE id = ?').run(id);
}

/**
 * Delete a specific digest by file path and digester
 */
export function deleteDigestByPathAndDigester(filePath: string, digester: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM digests WHERE file_path = ? AND digester = ?').run(filePath, digester);
}

/**
 * Delete all digests for a file path
 */
export function deleteDigestsForPath(filePath: string): number {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM digests WHERE file_path = ?').run(filePath);
  return result.changes;
}

/**
 * Delete all digests matching path prefix (for folder deletions)
 */
export function deleteDigestsByPrefix(pathPrefix: string): number {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM digests WHERE file_path LIKE ?').run(`${pathPrefix}%`);
  return result.changes;
}

/**
 * Update all digest file paths (for folder renames)
 */
export function updateDigestPaths(oldPath: string, newPath: string): void {
  const db = getDatabase();
  db.prepare('UPDATE digests SET file_path = ? WHERE file_path = ?').run(newPath, oldPath);
}

/**
 * Check if a digest exists for a file path and digester
 */
export function digestExists(filePath: string, digester: string): boolean {
  const db = getDatabase();

  const row = db
    .prepare('SELECT 1 FROM digests WHERE file_path = ? AND digester = ? LIMIT 1')
    .get(filePath, digester);

  return row !== undefined;
}

/**
 * Start a digest (create with todo status)
 * This is the preferred way to initiate digest processing
 */
export function startDigest(filePath: string, digester: string): Digest {
  const id = generateDigestId(filePath, digester);
  const now = new Date().toISOString();

  const digest: Digest = {
    id,
    filePath,
    digester,
    status: 'todo',
    content: null,
    sqlarName: null,
    error: null,
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
  // Simple hash of file path for shorter IDs
  const pathHash = Buffer.from(filePath).toString('base64url').slice(0, 12);
  return `${pathHash}-${digester}`;
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
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
