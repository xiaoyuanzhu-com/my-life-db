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
      processed_at, error, ai_slug, schema_version,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    item.id,
    item.folderName,
    item.type,
    JSON.stringify(item.files),
    item.status,
    item.processedAt,
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
    .get(id) as any;

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
    .get(folderName) as any;

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
  const params: any[] = [];

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

  const rows = db.prepare(sql).all(...params) as any[];

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
  const values: any[] = [];

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

  if (updates.processedAt !== undefined) {
    fields.push('processed_at = ?');
    values.push(updates.processedAt);
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
function rowToInboxItem(row: any): InboxItem {
  return {
    id: row.id,
    folderName: row.folder_name,
    type: row.type,
    files: JSON.parse(row.files) as InboxFile[],
    status: row.status,
    processedAt: row.processed_at,
    error: row.error,
    aiSlug: row.ai_slug,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
