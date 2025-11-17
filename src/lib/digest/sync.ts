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

  // Get all files that have at least one digest (i.e., been processed before)
  const processedFiles = db
    .prepare(
      `
      SELECT DISTINCT file_path FROM digests
      WHERE file_path LIKE 'inbox/%'
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
