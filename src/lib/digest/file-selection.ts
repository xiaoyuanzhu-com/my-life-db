/**
 * File selection logic for digest processing
 * Finds files that need digestion based on digest status
 */

import type BetterSqlite3 from 'better-sqlite3';
import { listDigestsForPath } from '@/lib/db/digests';
import { globalDigesterRegistry } from './registry';
import { getLogger } from '@/lib/log/logger';
import { MAX_DIGEST_ATTEMPTS } from './constants';

const log = getLogger({ module: 'FileSelection' });

const EXCLUDED_PATH_PREFIXES = ['app/', '.app/', '.git/', '.mylifedb/', 'node_modules/'];

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

  const exclusionClause = EXCLUDED_PATH_PREFIXES.map(() => 'path NOT LIKE ?').join(' AND ');
  const exclusionArgs = EXCLUDED_PATH_PREFIXES.map(prefix => `${prefix}%`);

  const candidateQuery = `
    SELECT path FROM files
    WHERE is_folder = 0
      ${exclusionClause ? `AND ${exclusionClause}` : ''}
    ORDER BY COALESCE(last_scanned_at, created_at) ASC
    LIMIT ?
    OFFSET ?
  `;

  const needsWork: string[] = [];
  const batchSize = Math.max(limit * 5, 50);
  let offset = 0;
  let checked = 0;

  while (needsWork.length < limit) {
    const candidateFiles = db
      .prepare(candidateQuery)
      .all(...exclusionArgs, batchSize, offset) as Array<{ path: string }>;

    if (candidateFiles.length === 0) {
      break;
    }

    checked += candidateFiles.length;

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
          if ((digest.attempts ?? 0) >= MAX_DIGEST_ATTEMPTS) {
            // Treat as permanent failure
            continue;
          }
          fileNeedsWork = true;
          break;
        }

        // status='completed' → done, continue to next type
        // status='skipped' → not applicable, continue to next type
        // status='in-progress' → in progress, skip for now (let it finish)
      }

      // Also check for orphaned digest types (todo/failed but no registered digester)
      // These can block processing if we don't handle them
      if (!fileNeedsWork) {
        const orphanedDigests = digests.filter(
          (d) => !allDigestTypes.includes(d.digester) &&
                 (d.status === 'todo' || (d.status === 'failed' && (d.attempts ?? 0) < MAX_DIGEST_ATTEMPTS))
        );
        if (orphanedDigests.length > 0) {
          log.debug(
            { path, orphanedTypes: orphanedDigests.map((d) => d.digester) },
            'file has orphaned digest types (will be skipped)'
          );
        }
      }

      if (fileNeedsWork) {
        needsWork.push(path);
      }
    }

    offset += batchSize;
  }

  log.debug(
    { count: needsWork.length, checked },
    'files needing digestion'
  );

  return needsWork;
}
