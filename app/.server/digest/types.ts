/**
 * Core types for the digest registry system
 */

import type { Digest, DigestInput, FileRecordRow } from '~/types/models';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * Digester interface - processes files and produces digest outputs
 *
 * A digester represents a processing implementation that can create one or more
 * digest outputs. Each output will have a unique digester name in the database.
 *
 * Example: 'url-crawl' digester creates multiple digests with names like
 * 'url-crawl-content', 'url-crawl-screenshot', etc.
 *
 * Design Principle: Users should see a deterministic set of digests for each file type.
 * - `skipped` = file type doesn't match (only from canDigest returning false)
 * - `failed` = digester applies but couldn't complete
 * - `completed` = digester ran successfully (content may be null)
 */
export interface Digester {
  /** Unique digester name (e.g., 'url-crawl', 'url-crawl-summary') */
  readonly name: string;

  /** Human-readable label for UI display (e.g., 'URL Crawler', 'Summary') */
  readonly label: string;

  /** Description of what this digester does */
  readonly description: string;

  /**
   * Optional list of digest records this digester produces aside from its own name.
   * Defaults to the digester name when not provided.
   */
  getOutputDigesters?(): string[];

  /**
   * Check if this digester applies to the given file TYPE.
   *
   * MUST be deterministic based on file type only:
   * - Check MIME type, file extension, or content structure (e.g., "is this a URL?")
   * - NEVER check existingDigests or processing status of other digesters
   *
   * @returns true if applicable, false to skip (marks as 'skipped' - terminal)
   */
  canDigest(
    filePath: string,
    file: FileRecordRow,
    db: BetterSqlite3.Database
  ): Promise<boolean>;

  /**
   * Execute digest operation.
   *
   * MUST return all outputs declared in getOutputDigesters().
   * MUST throw errors for failures (dependencies not ready, service errors).
   * MAY return completed with null content if nothing to extract.
   *
   * @returns Array of digests created (each with their own unique digester name)
   * @throws Error if processing fails (will be retried up to 3 times)
   */
  digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    db: BetterSqlite3.Database
  ): Promise<DigestInput[]>;
}
