// Database operations for items table
import { getDatabase } from './connection';
import type { Item, ItemRecord, ItemFile } from '@/types';

/**
 * Create a new item in the database
 */
export function createItem(item: Item): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO items (
      id, name, raw_type, detected_type, is_folder, path, files, status,
      created_at, updated_at, schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    item.id,
    item.name,
    item.rawType,
    item.detectedType,
    item.isFolder ? 1 : 0,
    item.path,
    item.files ? JSON.stringify(item.files) : null,
    item.status,
    item.createdAt,
    item.updatedAt,
    item.schemaVersion
  );
}

/**
 * Get an item by ID
 */
export function getItemById(id: string): Item | null {
  const db = getDatabase();

  const row = db
    .prepare('SELECT * FROM items WHERE id = ?')
    .get(id) as ItemRecord | undefined;

  if (!row) return null;

  return recordToItem(row);
}

/**
 * Get an item by path
 */
export function getItemByPath(path: string): Item | null {
  const db = getDatabase();

  const row = db
    .prepare('SELECT * FROM items WHERE path = ?')
    .get(path) as ItemRecord | undefined;

  if (!row) return null;

  return recordToItem(row);
}

/**
 * Get an item by name within a location (e.g., inbox)
 */
export function getItemByName(name: string, locationPrefix: string = 'inbox'): Item | null {
  const db = getDatabase();

  const row = db
    .prepare('SELECT * FROM items WHERE name = ? AND path LIKE ?')
    .get(name, `${locationPrefix}%`) as ItemRecord | undefined;

  if (!row) return null;

  return recordToItem(row);
}

/**
 * List all items in a location (e.g., inbox, notes, journal)
 */
export function listItems(options?: {
  location?: string; // 'inbox', 'notes', 'journal', etc.
  status?: string;
  rawType?: string;
  detectedType?: string;
  limit?: number;
  offset?: number;
}): Item[] {
  const db = getDatabase();

  let sql = 'SELECT * FROM items';
  const params: (string | number)[] = [];
  const conditions: string[] = [];

  if (options?.location) {
    // Match exact location or subdirectories
    // e.g., 'inbox' matches 'inbox' and 'inbox/*'
    conditions.push('(path = ? OR path LIKE ?)');
    params.push(options.location, `${options.location}/%`);
  }

  if (options?.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }

  if (options?.rawType) {
    conditions.push('raw_type = ?');
    params.push(options.rawType);
  }

  if (options?.detectedType) {
    conditions.push('detected_type = ?');
    params.push(options.detectedType);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
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

  const rows = db.prepare(sql).all(...params) as ItemRecord[];

  return rows.map(recordToItem);
}

/**
 * Update an item
 */
export function updateItem(
  id: string,
  updates: Partial<Omit<Item, 'id' | 'createdAt'>>
): void {
  const db = getDatabase();

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }

  if (updates.rawType !== undefined) {
    fields.push('raw_type = ?');
    values.push(updates.rawType);
  }

  if (updates.detectedType !== undefined) {
    fields.push('detected_type = ?');
    values.push(updates.detectedType);
  }

  if (updates.isFolder !== undefined) {
    fields.push('is_folder = ?');
    values.push(updates.isFolder ? 1 : 0);
  }

  if (updates.path !== undefined) {
    fields.push('path = ?');
    values.push(updates.path);
  }

  if (updates.files !== undefined) {
    fields.push('files = ?');
    values.push(updates.files ? JSON.stringify(updates.files) : null);
  }

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (updates.schemaVersion !== undefined) {
    fields.push('schema_version = ?');
    values.push(updates.schemaVersion);
  }

  // Always update updated_at
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());

  values.push(id);

  const sql = `UPDATE items SET ${fields.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...values);
}

/**
 * Delete an item (note: files on disk not deleted, only DB record)
 */
export function deleteItem(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
}

/**
 * Check if a name exists in a location (for collision detection)
 */
export function itemNameExists(name: string, locationPrefix: string = 'inbox'): boolean {
  const db = getDatabase();

  const row = db
    .prepare('SELECT 1 FROM items WHERE name = ? AND path LIKE ? LIMIT 1')
    .get(name, `${locationPrefix}%`);

  return row !== undefined;
}

/**
 * Get a unique name by appending a counter if needed
 */
export function getUniqueName(baseName: string, locationPrefix: string = 'inbox'): string {
  if (!itemNameExists(baseName, locationPrefix)) {
    return baseName;
  }

  // Extract extension if present
  const lastDot = baseName.lastIndexOf('.');
  const hasExtension = lastDot > 0 && lastDot < baseName.length - 1;

  let nameWithoutExt: string;
  let extension: string;

  if (hasExtension) {
    nameWithoutExt = baseName.substring(0, lastDot);
    extension = baseName.substring(lastDot); // includes the dot
  } else {
    nameWithoutExt = baseName;
    extension = '';
  }

  // Try adding counters
  for (let i = 1; i < 1000; i++) {
    const newName = `${nameWithoutExt}-${i}${extension}`;
    if (!itemNameExists(newName, locationPrefix)) {
      return newName;
    }
  }

  // Fallback: use timestamp
  return `${nameWithoutExt}-${Date.now()}${extension}`;
}

/**
 * Convert database record to Item
 */
function recordToItem(record: ItemRecord): Item {
  return {
    id: record.id,
    name: record.name,
    rawType: record.raw_type as Item['rawType'],
    detectedType: record.detected_type,
    isFolder: record.is_folder === 1,
    path: record.path,
    files: record.files ? JSON.parse(record.files) as ItemFile[] : null,
    status: record.status as Item['status'],
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    schemaVersion: record.schema_version,
  };
}
