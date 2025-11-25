/**
 * Digest - Digests table models
 *
 * AI-generated content for files. Each file can have multiple digest types
 * (summary, tags, slug, screenshot, etc.). Text content stored in 'content'
 * field, binary content in SQLAR archive.
 */

import type { DigestStatus } from './digest-status';

/**
 * Digest record row (snake_case - matches SQLite schema exactly)
 *
 * Primary key: id (hash of file_path + digester)
 */
export interface DigestRecordRow {
  /** Digest ID (hash-based from file_path + digester) */
  id: string;

  /** Path to file (e.g., 'inbox/photo.jpg' or 'inbox/uuid-folder') */
  file_path: string;

  /** Digester name (e.g., 'url-crawl-content', 'url-crawl-summary') */
  digester: string;

  /** Processing status (see DigestStatus enum) */
  status: string;

  /** Text content (summary text, JSON for tags/slug) - null for binary digests */
  content: string | null;

  /** Filename in SQLAR archive (for binary digests like screenshots) */
  sqlar_name: string | null;

  /** Error message if status='failed' */
  error: string | null;

  /** Number of attempts made by this digester */
  attempts: number;

  /** ISO 8601 timestamp when digest was created */
  created_at: string;

  /** ISO 8601 timestamp when digest was last updated */
  updated_at: string;
}

/**
 * Digest record (camelCase - for TypeScript usage)
 *
 * AI-generated content for a file. Each file can have multiple digests
 * of different types (summary, tags, slug, screenshot, etc.).
 */
export interface Digest {
  /** Digest ID (opaque, UUID) */
  id: string;

  /** Path to file (e.g., 'inbox/photo.jpg' or 'inbox/uuid-folder') */
  filePath: string;

  /** Digester name (e.g., 'url-crawl-content', 'url-crawl-summary') */
  digester: string;

  /** Processing status (see DigestStatus enum) */
  status: DigestStatus;

  /** Text content (summary text, JSON for tags/slug) - null for binary digests */
  content: string | null;

  /** Filename in SQLAR archive (for binary digests like screenshots) */
  sqlarName: string | null;

  /** Error message if status='failed' */
  error: string | null;

  /** Number of attempts performed for this digester */
  attempts: number;

  /** ISO 8601 timestamp when digest was created */
  createdAt: string;

  /** ISO 8601 timestamp when digest was last updated */
  updatedAt: string;
}

/**
 * Digest payload returned by digesters (ID assigned by coordinator/DB)
 */
export type DigestInput = Omit<Digest, 'id'> & { id?: string };

/**
 * Conversion helper: DigestRecordRow → Digest
 */
export function rowToDigest(row: DigestRecordRow): Digest {
  return {
    id: row.id,
    filePath: row.file_path,
    digester: row.digester,
    status: row.status as DigestStatus,
    content: row.content,
    sqlarName: row.sqlar_name,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
