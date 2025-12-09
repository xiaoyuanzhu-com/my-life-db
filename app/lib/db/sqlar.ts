// SQLAR (SQLite Archive) helper functions
// SQLAR is a standard SQLite format for storing compressed files in a database
import 'server-only';
import type BetterSqlite3 from 'better-sqlite3';
import { deflate, inflate } from 'zlib';
import { promisify } from 'util';
import { withDatabase } from './client';
import { getLogger } from '~/lib/log/logger';

const log = getLogger({ module: 'SQLAR' });
const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

/**
 * Store a file in SQLAR format
 * @param db Database connection
 * @param name File path/name in the archive
 * @param data File content (Buffer or string)
 * @param mode File permissions (default: 0o644)
 * @returns true if successful
 */
export async function sqlarStore(
  db: BetterSqlite3.Database,
  name: string,
  data: Buffer | string,
  mode: number = 0o644
): Promise<boolean> {
  try {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
    const originalSize = buffer.length;
    const compressed = await deflateAsync(buffer);
    const mtime = Math.floor(Date.now() / 1000);

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO sqlar (name, mode, mtime, sz, data)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(name, mode, mtime, originalSize, compressed);

    log.debug({ name, originalSize, compressedSize: compressed.length }, 'stored file in sqlar');
    return true;
  } catch (error) {
    log.error({ err: error, name }, 'failed to store file in sqlar');
    return false;
  }
}

/**
 * Retrieve a file from SQLAR
 * Can be called with an explicit db or uses the shared connection by default.
 * @param dbOrName Database connection or file path/name in the archive
 * @returns File content as Buffer, or null if not found
 */
export async function sqlarGet(db: BetterSqlite3.Database, name: string): Promise<Buffer | null>;
export async function sqlarGet(name: string): Promise<Buffer | null>;
export async function sqlarGet(
  dbOrName: BetterSqlite3.Database | string,
  maybeName?: string
): Promise<Buffer | null> {
  const db = typeof dbOrName === 'string' ? withDatabase(database => database) : dbOrName;
  const name = typeof dbOrName === 'string' ? dbOrName : maybeName!;

  try {
    const stmt = db.prepare('SELECT data, sz FROM sqlar WHERE name = ?');
    const row = stmt.get(name) as { data: Buffer; sz: number } | undefined;

    if (!row) {
      log.debug({ name }, 'file not found in sqlar');
      return null;
    }

    const decompressed = await inflateAsync(row.data);

    log.debug({ name, size: row.sz }, 'retrieved file from sqlar');
    return decompressed;
  } catch (error) {
    log.error({ err: error, name }, 'failed to retrieve file from sqlar');
    return null;
  }
}

/**
 * Check if a file exists in SQLAR
 * @param db Database connection
 * @param name File path/name in the archive
 * @returns true if file exists
 */
export function sqlarExists(
  db: BetterSqlite3.Database,
  name: string
): boolean {
  const stmt = db.prepare('SELECT 1 FROM sqlar WHERE name = ? LIMIT 1');
  const row = stmt.get(name);
  return row !== undefined;
}

/**
 * Delete a file from SQLAR
 * @param db Database connection
 * @param name File path/name in the archive
 * @returns true if successful
 */
export function sqlarDelete(
  db: BetterSqlite3.Database,
  name: string
): boolean {
  try {
    const stmt = db.prepare('DELETE FROM sqlar WHERE name = ?');
    const result = stmt.run(name);

    log.debug({ name, changes: result.changes }, 'deleted file from sqlar');
    return result.changes > 0;
  } catch (error) {
    log.error({ err: error, name }, 'failed to delete file from sqlar');
    return false;
  }
}

/**
 * List all files in SQLAR with a given prefix
 * @param db Database connection
 * @param prefix File path prefix (e.g., 'item-id-123/')
 * @returns Array of file info objects
 */
export function sqlarList(
  db: BetterSqlite3.Database,
  prefix: string = ''
): Array<{ name: string; size: number; mtime: number }> {
  try {
    const stmt = db.prepare(`
      SELECT name, sz as size, mtime
      FROM sqlar
      WHERE name LIKE ?
      ORDER BY name
    `);

    const rows = stmt.all(`${prefix}%`) as Array<{ name: string; size: number; mtime: number }>;

    log.debug({ prefix, count: rows.length }, 'listed files in sqlar');
    return rows;
  } catch (error) {
    log.error({ err: error, prefix }, 'failed to list files in sqlar');
    return [];
  }
}

/**
 * Delete all files with a given prefix (e.g., all files for an item)
 * @param dbOrPrefix Database connection or prefix to delete (uses shared connection when omitted)
 * @param prefix File path prefix
 * @returns Number of files deleted
 */
export function sqlarDeletePrefix(db: BetterSqlite3.Database, prefix: string): number;
export function sqlarDeletePrefix(prefix: string): number;
export function sqlarDeletePrefix(
  dbOrPrefix: BetterSqlite3.Database | string,
  maybePrefix?: string
): number {
  const db = typeof dbOrPrefix === 'string' ? withDatabase(database => database) : dbOrPrefix;
  const prefix = typeof dbOrPrefix === 'string' ? dbOrPrefix : maybePrefix!;

  try {
    const stmt = db.prepare('DELETE FROM sqlar WHERE name LIKE ?');
    const result = stmt.run(`${prefix}%`);

    log.debug({ prefix, changes: result.changes }, 'deleted files by prefix from sqlar');
    return result.changes;
  } catch (error) {
    log.error({ err: error, prefix }, 'failed to delete files by prefix from sqlar');
    return 0;
  }
}

/**
 * Get file metadata from SQLAR without decompressing
 * @param db Database connection
 * @param name File path/name
 * @returns File metadata or null if not found
 */
export function sqlarMetadata(
  db: BetterSqlite3.Database,
  name: string
): { name: string; mode: number; mtime: number; size: number } | null {
  try {
    const stmt = db.prepare(`
      SELECT name, mode, mtime, sz as size
      FROM sqlar
      WHERE name = ?
    `);

    const row = stmt.get(name) as { name: string; mode: number; mtime: number; size: number } | undefined;

    return row || null;
  } catch (error) {
    log.error({ err: error, name }, 'failed to get metadata from sqlar');
    return null;
  }
}
