/**
 * File selection logic for digest processing
 * Finds files that need digestion based on digest status
 */

import type BetterSqlite3 from 'better-sqlite3';
import { listDigestsForPath } from '@/lib/db/digests';
import { globalDigesterRegistry } from './registry';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'FileSelection' });

/**
 * Find files that need digestion.
 * Returns files where:
 * - Never been processed by any digester (no digest records), OR
 * - Have pending digests (not skipped), OR
 * - Have failed digests (should retry)
 *
 * @param db Database instance
 * @param limit Maximum number of files to return
 * @returns Array of file paths that need digestion
 */
export function findFilesNeedingDigestion(
  db: BetterSqlite3.Database,
  limit: number = 100
): string[] {
  const allDigestTypes = globalDigesterRegistry.getAllDigestTypes();

  if (allDigestTypes.length === 0) {
    log.warn({}, 'no digesters registered');
    return [];
  }

  // Get candidate files from inbox (recent first)
  // Multiply limit to account for filtering
  const candidateFiles = db
    .prepare(
      `
      SELECT path FROM files
      WHERE path LIKE 'inbox/%'
        AND is_folder = 0
      ORDER BY created_at DESC
      LIMIT ?
    `
    )
    .all(limit * 3) as Array<{ path: string }>;

  const needsWork: string[] = [];

  for (const { path } of candidateFiles) {
    if (needsWork.length >= limit) break;

    const digests = listDigestsForPath(path);
    const digestMap = new Map(digests.map((d) => [d.digester, d]));

    let fileNeedsWork = false;

    for (const expectedType of allDigestTypes) {
      const digest = digestMap.get(expectedType);

      if (!digest) {
        // No digest record = never attempted
        fileNeedsWork = true;
        break;
      }

      if (digest.status === 'todo') {
        // Todo (not skipped) = needs work
        // Note: skipped digests have status='skipped', not 'todo'
        fileNeedsWork = true;
        break;
      }

      if (digest.status === 'failed') {
        // Failed = should retry
        fileNeedsWork = true;
        break;
      }

      // status='completed' → done, continue to next type
      // status='skipped' → not applicable, continue to next type
      // status='in-progress' → in progress, skip for now (let it finish)
    }

    if (fileNeedsWork) {
      needsWork.push(path);
    }
  }

  log.info(
    { count: needsWork.length, checked: candidateFiles.length },
    'files needing digestion'
  );

  return needsWork;
}
