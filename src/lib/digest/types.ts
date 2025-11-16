/**
 * Core types for the digest registry system
 */

import type { Digest } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * File metadata from files table
 */
export interface FileRow {
  path: string;
  name: string;
  is_folder: number;
  size: number | null;
  mime_type: string | null;
  hash: string | null;
  modified_at: string;
  created_at: string;
  last_scanned_at: string;
}

/**
 * Digester interface - processes files and produces digest outputs
 */
export interface Digester {
  /** Unique identifier (e.g., 'url-crawl', 'summarize') */
  readonly id: string;

  /** Human-readable name for logging/UI */
  readonly name: string;

  /** Digest types this digester produces (e.g., ['content-md', 'screenshot']) */
  readonly produces: string[];

  /** Optional: Digest types this digester requires (e.g., ['content-md']) */
  readonly requires?: string[];

  /**
   * Check if this digester can process the given file.
   * @returns true if applicable, false to skip
   */
  canDigest(
    filePath: string,
    file: FileRow,
    existingDigests: Digest[],
    db: BetterSqlite3.Database
  ): Promise<boolean>;

  /**
   * Execute digest operation.
   * @returns Array of digests created, or null to skip
   */
  digest(
    filePath: string,
    file: FileRow,
    existingDigests: Digest[],
    db: BetterSqlite3.Database
  ): Promise<Digest[] | null>;
}
