/**
 * Pin operations
 *
 * Manages pinned items - user-facing markers for quick access.
 */

import { randomUUID } from 'crypto';
import { dbSelect, dbSelectOne, dbRun } from './client';
import { getLogger } from '~/.server/log/logger';
import type { PinRecordRow, PinRecord } from '~/types/pin';
import { rowToPinRecord } from '~/types/pin';
import { getFileByPath } from './files';
import type { FileRecord } from '~/types/models';

// Re-export types for convenience
export type { PinRecord, PinRecordRow };

const log = getLogger({ module: 'DBPins' });

/**
 * Pin a file
 */
export function pinFile(path: string): PinRecord {
  const file = getFileByPath(path);
  if (!file) {
    log.error({ path }, 'Cannot pin file: file not found');
    throw new Error(`File not found: ${path}`);
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  // Extract display text
  const displayText = getDisplayText(file);

  dbRun(
    `INSERT INTO pins (id, file_path, pinned_at, display_text, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET pinned_at = ?, display_text = ?`,
    [id, path, now, displayText, now, now, displayText]
  );

  log.info({ path, displayText }, 'pinned file');

  const pin = getPinByPath(path);
  if (!pin) throw new Error('Failed to create pin');
  return pin;
}

/**
 * Unpin a file
 */
export function unpinFile(path: string): void {
  dbRun('DELETE FROM pins WHERE file_path = ?', [path]);
  log.info({ path }, 'unpinned file');
}

/**
 * Check if file is pinned
 */
export function isPinned(path: string): boolean {
  const result = dbSelectOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM pins WHERE file_path = ?',
    [path]
  );
  return (result?.count ?? 0) > 0;
}

/**
 * Toggle pin state
 */
export function togglePinFile(path: string): boolean {
  if (isPinned(path)) {
    unpinFile(path);
    return false;
  } else {
    pinFile(path);
    return true;
  }
}

/**
 * Get pin by file path
 */
export function getPinByPath(path: string): PinRecord | null {
  const row = dbSelectOne<PinRecordRow>(
    'SELECT * FROM pins WHERE file_path = ?',
    [path]
  );
  return row ? rowToPinRecord(row) : null;
}

/**
 * List all pinned files for a path prefix
 * Ordered by most recently pinned first
 */
export function listPinnedFiles(pathPrefix: string): PinRecord[] {
  const query = `
    SELECT p.* FROM pins p
    INNER JOIN files f ON p.file_path = f.path
    WHERE f.path LIKE ?
    ORDER BY p.pinned_at DESC
  `;
  const rows = dbSelect<PinRecordRow>(query, [`${pathPrefix}%`]);
  return rows.map(rowToPinRecord);
}

/**
 * Get display text from file
 * Uses first line of text preview if available, otherwise filename
 */
function getDisplayText(file: FileRecord): string {
  if (file.textPreview) {
    const firstLine = file.textPreview.split('\n')[0].trim();
    if (firstLine) {
      return firstLine.length > 50 ? firstLine.slice(0, 50) + '...' : firstLine;
    }
  }
  return file.name;
}
