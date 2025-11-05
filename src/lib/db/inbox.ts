// Database operations for inbox table
import { getDatabase } from './connection';
import type { InboxItem, InboxFile } from '@/types';

/**
 * Create a new inbox item in the database
 */
export function createInboxRecord(item: InboxItem): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO inbox (
      id, folder_name, type, files, status,
      enriched_at, error, ai_slug, schema_version,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    item.id,
    item.folderName,
    item.type,
    JSON.stringify(item.files),
    item.status,
    item.enrichedAt,
    item.error,
    item.aiSlug,
    item.schemaVersion,
    item.createdAt,
    item.updatedAt
  );
}

/**
 * Get an inbox item by ID
 */
export function getInboxItemById(id: string): InboxItem | null {
  const db = getDatabase();

  const row = db
    .prepare('SELECT * FROM inbox WHERE id = ?')
    .get(id) as unknown;

  if (!row) return null;

  return rowToInboxItem(row);
}

/**
 * Get an inbox item by folder name
 */
export function getInboxItemByFolderName(folderName: string): InboxItem | null {
  const db = getDatabase();

  const row = db
    .prepare('SELECT * FROM inbox WHERE folder_name = ?')
    .get(folderName) as unknown;

  if (!row) return null;

  return rowToInboxItem(row);
}

/**
 * Get an inbox item by generated slug (ai_slug)
 */
export function getInboxItemBySlug(slug: string): InboxItem | null {
  if (!slug || slug.trim().length === 0) return null;

  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM inbox WHERE ai_slug = ?')
    .get(slug) as unknown;

  if (!row) return null;
  return rowToInboxItem(row);
}

/**
 * List all inbox items
 */
export function listInboxItems(options?: {
  status?: string;
  limit?: number;
  offset?: number;
}): InboxItem[] {
  const db = getDatabase();

  let sql = 'SELECT * FROM inbox';
  const params: (string | number)[] = [];

  if (options?.status) {
    sql += ' WHERE status = ?';
    params.push(options.status);
  }

  sql += ' ORDER BY created_at DESC';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);

    if (options?.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }
  }

  const rows = db.prepare(sql).all(...params) as unknown[];

  return rows.map(rowToInboxItem);
}

/**
 * Update an inbox item
 */
export function updateInboxItem(
  id: string,
  updates: Partial<Omit<InboxItem, 'id' | 'createdAt'>>
): void {
  const db = getDatabase();

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.folderName !== undefined) {
    fields.push('folder_name = ?');
    values.push(updates.folderName);
  }

  if (updates.type !== undefined) {
    fields.push('type = ?');
    values.push(updates.type);
  }

  if (updates.files !== undefined) {
    fields.push('files = ?');
    values.push(JSON.stringify(updates.files));
  }

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (updates.enrichedAt !== undefined) {
    fields.push('enriched_at = ?');
    values.push(updates.enrichedAt);
  }

  if (updates.error !== undefined) {
    fields.push('error = ?');
    values.push(updates.error);
  }

  if (updates.aiSlug !== undefined) {
    fields.push('ai_slug = ?');
    values.push(updates.aiSlug);
  }

  if (updates.schemaVersion !== undefined) {
    fields.push('schema_version = ?');
    values.push(updates.schemaVersion);
  }

  // Always update updated_at
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());

  values.push(id);

  const sql = `UPDATE inbox SET ${fields.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...values);
}

/**
 * Delete an inbox item
 */
export function deleteInboxItem(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM inbox WHERE id = ?').run(id);
}

/**
 * Convert database row to InboxItem
 */
function rowToInboxItem(row: unknown): InboxItem {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    folderName: r.folder_name as string,
    type: r.type as InboxItem['type'],
    files: JSON.parse(r.files as string) as InboxFile[],
    status: r.status as InboxItem['status'],
    enrichedAt: r.enriched_at as string | null,
    error: r.error as string | null,
    aiSlug: r.ai_slug as string | null,
    schemaVersion: r.schema_version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
