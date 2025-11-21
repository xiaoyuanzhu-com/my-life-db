/**
 * Sync function for digest records
 * Creates digest records for new digesters when they are added
 */

import type BetterSqlite3 from 'better-sqlite3';
import { listDigestsForPath, createDigest } from '@/lib/db/digests';
import { generateDigestId } from '@/lib/db/digests';
import { globalDigesterRegistry } from './registry';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'DigestSync' });

/**
 * Clean up orphaned digest records (digests for digesters that no longer exist).
 * Marks them as 'skipped' to prevent blocking file processing.
 *
 * @param db Database instance
 */
function cleanupOrphanedDigests(db: BetterSqlite3.Database): void {
  const allDigestTypes = globalDigesterRegistry.getAllDigestTypes();
  const typeSet = new Set(allDigestTypes);

  // Find digests that don't have a registered digester
  const orphanedDigests = db
    .prepare(
      `
      SELECT DISTINCT digester FROM digests
      WHERE status IN ('todo', 'failed')
    `
    )
    .all() as Array<{ digester: string }>;

  const orphanedTypes = orphanedDigests
    .map((d) => d.digester)
    .filter((type) => !typeSet.has(type));

  if (orphanedTypes.length === 0) {
    return;
  }

  log.info({ orphanedTypes }, 'marking orphaned digest types as skipped');

  for (const type of orphanedTypes) {
    const result = db
      .prepare(
        `
        UPDATE digests
        SET status = 'skipped',
            error = 'Digester no longer registered',
            updated_at = ?
        WHERE digester = ?
          AND status IN ('todo', 'failed')
      `
      )
      .run(new Date().toISOString(), type);

    if (result.changes > 0) {
      log.info({ digester: type, updated: result.changes }, 'orphaned digests marked as skipped');
    }
  }
}

/**
 * Sync new digesters for files that have been processed before.
 * Call this when new digesters are registered to ensure existing files
 * get digest records for the new digesters.
 *
 * This function is idempotent - safe to run multiple times.
 *
 * @param db Database instance
 */
export function syncNewDigesters(db: BetterSqlite3.Database): void {
  const allDigestTypes = globalDigesterRegistry.getAllDigestTypes();

  if (allDigestTypes.length === 0) {
    log.info({}, 'no digesters registered, skipping sync');
    return;
  }

  // First, clean up orphaned digest types
  cleanupOrphanedDigests(db);

  // Get all files that have at least one digest (i.e., been processed before)
  const processedFiles = db
    .prepare(
      `
      SELECT DISTINCT file_path FROM digests
    `
    )
    .all() as Array<{ file_path: string }>;

  if (processedFiles.length === 0) {
    log.info({}, 'no files with existing digests, skipping sync');
    return;
  }

  log.info(
    { count: processedFiles.length, digesters: allDigestTypes },
    'syncing digest records for processed files'
  );

  let added = 0;

  for (const { file_path } of processedFiles) {
    const existing = listDigestsForPath(file_path);
    const existingTypes = new Set(existing.map((d) => d.digester));

    for (const type of allDigestTypes) {
      if (!existingTypes.has(type)) {
        // New digest type for this file - create todo record
        try {
          createDigest({
            id: generateDigestId(file_path, type),
            filePath: file_path,
            digester: type,
            status: 'todo',
            content: null,
            sqlarName: null,
            error: null,
            attempts: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          added++;
        } catch (error) {
          // Digest might already exist (race condition or duplicate call)
          // Safe to ignore
          if (error instanceof Error && !error.message.includes('UNIQUE constraint')) {
            log.error({ error, file_path, type }, 'failed to create digest record');
          }
        }
      }
    }
  }

  log.info({ added }, 'digest sync completed');
}
