/**
 * Digest - Digests table models
 *
 * AI-generated content for files. Each file can have multiple digest types
 * (summary, tags, slug, screenshot, etc.). Text content stored in 'content'
 * field, binary content in SQLAR archive.
 */

import type { EnrichmentStatus } from '../enums/EnrichmentStatus';

/**
 * Digest record row (snake_case - matches SQLite schema exactly)
 *
 * Primary key: id (hash of file_path + digest_type)
 */
export interface DigestRecordRow {
  /** Digest ID (hash-based from file_path + digest_type) */
  id: string;

  /** Path to file (e.g., 'inbox/photo.jpg' or 'inbox/uuid-folder') */
  file_path: string;

  /** Type of digest (see DigestType enum) */
  digest_type: string;

  /** Processing status (see EnrichmentStatus enum) */
  status: string;

  /** Text content (summary text, JSON for tags/slug) - null for binary digests */
  content: string | null;

  /** Filename in SQLAR archive (for binary digests like screenshots) */
  sqlar_name: string | null;

  /** Error message if status='failed' */
  error: string | null;

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
  /** Digest ID (hash-based from filePath + digestType) */
  id: string;

  /** Path to file (e.g., 'inbox/photo.jpg' or 'inbox/uuid-folder') */
  filePath: string;

  /** Type of digest (see DigestType enum) */
  digestType: string;

  /** Processing status (see EnrichmentStatus enum) */
  status: EnrichmentStatus;

  /** Text content (summary text, JSON for tags/slug) - null for binary digests */
  content: string | null;

  /** Filename in SQLAR archive (for binary digests like screenshots) */
  sqlarName: string | null;

  /** Error message if status='failed' */
  error: string | null;

  /** ISO 8601 timestamp when digest was created */
  createdAt: string;

  /** ISO 8601 timestamp when digest was last updated */
  updatedAt: string;
}

/**
 * Conversion helper: DigestRecordRow → Digest
 */
export function rowToDigest(row: DigestRecordRow): Digest {
  return {
    id: row.id,
    filePath: row.file_path,
    digestType: row.digest_type,
    status: row.status as EnrichmentStatus,
    content: row.content,
    sqlarName: row.sqlar_name,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
