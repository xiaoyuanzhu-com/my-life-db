// Database operations for digests table
import { getDatabase } from './connection';
import type { Digest, DigestRecord } from '@/types';

/**
 * Create a new digest in the database
 */
export function createDigest(digest: Digest): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO digests (
      id, item_id, digest_type, status, content, sqlar_name, error,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    digest.id,
    digest.itemId,
    digest.digestType,
    digest.status,
    digest.content,
    digest.sqlarName,
    digest.error,
    digest.createdAt,
    digest.updatedAt
  );
}

/**
 * Get a digest by ID
 */
export function getDigestById(id: string): Digest | null {
  const db = getDatabase();

  const row = db
    .prepare('SELECT * FROM digests WHERE id = ?')
    .get(id) as DigestRecord | undefined;

  if (!row) return null;

  return recordToDigest(row);
}

/**
 * Get a digest by item ID and type
 */
export function getDigestByItemAndType(itemId: string, digestType: string): Digest | null {
  const db = getDatabase();

  const row = db
    .prepare('SELECT * FROM digests WHERE item_id = ? AND digest_type = ?')
    .get(itemId, digestType) as DigestRecord | undefined;

  if (!row) return null;

  return recordToDigest(row);
}

/**
 * List all digests for an item
 */
export function listDigestsForItem(itemId: string): Digest[] {
  const db = getDatabase();

  const rows = db
    .prepare('SELECT * FROM digests WHERE item_id = ? ORDER BY created_at DESC')
    .all(itemId) as DigestRecord[];

  return rows.map(recordToDigest);
}

/**
 * List digests by type (across all items)
 */
export function listDigestsByType(digestType: string, limit?: number): Digest[] {
  const db = getDatabase();

  let sql = 'SELECT * FROM digests WHERE digest_type = ? ORDER BY created_at DESC';
  const params: (string | number)[] = [digestType];

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const rows = db.prepare(sql).all(...params) as DigestRecord[];

  return rows.map(recordToDigest);
}

/**
 * Update a digest
 */
export function updateDigest(
  id: string,
  updates: Partial<Omit<Digest, 'id' | 'itemId' | 'createdAt'>>
): void {
  const db = getDatabase();

  const fields: string[] = [];
  const values: (string | null)[] = [];

  if (updates.digestType !== undefined) {
    fields.push('digest_type = ?');
    values.push(updates.digestType);
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
 * Delete a digest
 */
export function deleteDigest(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM digests WHERE id = ?').run(id);
}

/**
 * Delete all digests for an item
 */
export function deleteDigestsForItem(itemId: string): number {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM digests WHERE item_id = ?').run(itemId);
  return result.changes;
}

/**
 * Check if a digest exists for an item and type
 */
export function digestExists(itemId: string, digestType: string): boolean {
  const db = getDatabase();

  const row = db
    .prepare('SELECT 1 FROM digests WHERE item_id = ? AND digest_type = ? LIMIT 1')
    .get(itemId, digestType);

  return row !== undefined;
}

/**
 * Convert database record to Digest
 */
function recordToDigest(record: DigestRecord): Digest {
  return {
    id: record.id,
    itemId: record.item_id,
    digestType: record.digest_type,
    status: record.status as Digest['status'],
    content: record.content,
    sqlarName: record.sqlar_name,
    error: record.error,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
