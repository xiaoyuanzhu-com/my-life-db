/**
 * Core types for the digest registry system
 */

import type { Digest, DigestInput, FileRecordRow } from '@/types/models';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * Digester interface - processes files and produces digest outputs
 *
 * A digester represents a processing implementation that can create one or more
 * digest outputs. Each output will have a unique digester name in the database.
 *
 * Example: 'url-crawl' digester creates multiple digests with names like
 * 'url-crawl-content', 'url-crawl-screenshot', etc.
 */
export interface Digester {
  /** Unique digester name (e.g., 'url-crawl', 'summarize') */
  readonly name: string;

  /**
   * Optional list of digest records this digester produces aside from its own name.
   * Defaults to the digester name when not provided.
   */
  getOutputDigesters?(): string[];

  /**
   * Check if this digester can process the given file.
   * @returns true if applicable, false to skip
   */
  canDigest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    db: BetterSqlite3.Database
  ): Promise<boolean>;

  /**
   * Execute digest operation.
   * @returns Array of digests created (each with their own unique digester name), or null to skip
   */
  digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    db: BetterSqlite3.Database
  ): Promise<DigestInput[] | null>;

  /**
   * Optional hook to signal reprocessing even when outputs are already completed/skipped.
   * Return true when upstream inputs changed and outputs should be regenerated.
   */
  shouldReprocessCompleted?(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    db: BetterSqlite3.Database
  ): Promise<boolean> | boolean;
}
