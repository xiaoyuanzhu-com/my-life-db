/**
 * Pin Record - Pins table models
 *
 * Stores pinned items (handful at most). Pins are user-facing markers
 * for quick access to important files.
 */

/**
 * Pin record row (snake_case - matches SQLite schema exactly)
 *
 * Primary key: id (UUID)
 * Unique constraint: file_path
 */
export interface PinRecordRow {
  /** UUID for primary key */
  id: string;

  /** File path being pinned (UNIQUE, references files.path) */
  file_path: string;

  /** ISO 8601 timestamp when pinned */
  pinned_at: string;

  /** Cached display text (first line of textPreview or filename) */
  display_text: string | null;

  /** ISO 8601 timestamp when pin record created */
  created_at: string;
}

/**
 * Pin record (camelCase - for TypeScript usage)
 *
 * TypeScript-friendly version of PinRecordRow.
 */
export interface PinRecord {
  /** UUID for primary key */
  id: string;

  /** File path being pinned */
  filePath: string;

  /** ISO 8601 timestamp when pinned */
  pinnedAt: string;

  /** Cached display text (first line of textPreview or filename) */
  displayText: string | null;

  /** ISO 8601 timestamp when pin record created */
  createdAt: string;
}

/**
 * Conversion helper: PinRecordRow → PinRecord
 */
export function rowToPinRecord(row: PinRecordRow): PinRecord {
  return {
    id: row.id,
    filePath: row.file_path,
    pinnedAt: row.pinned_at,
    displayText: row.display_text,
    createdAt: row.created_at,
  };
}

/**
 * Pinned item for UI display
 */
export interface PinnedItem {
  /** File path */
  path: string;

  /** Filename */
  name: string;

  /** ISO 8601 timestamp when pinned */
  pinnedAt: string;

  /** Display text (first line or filename) */
  displayText: string;

  /** Cursor for direct navigation (created_at:path) */
  cursor: string;
}
