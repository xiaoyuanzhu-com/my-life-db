/**
 * File selection logic for digest processing
 * Finds files that need digestion based on digest status
 */

import type BetterSqlite3 from 'better-sqlite3';
import { globalDigesterRegistry } from './registry';
import { getLogger } from '@/lib/log/logger';
import { MAX_DIGEST_ATTEMPTS } from './constants';

const log = getLogger({ module: 'FileSelection' });

export const EXCLUDED_PATH_PREFIXES = ['app/', '.app/', '.git/', '.mylifedb/', 'node_modules/'];

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

  const exclusionClause = EXCLUDED_PATH_PREFIXES.map(() => 'f.path NOT LIKE ?').join(' AND ');
  const exclusionArgs = EXCLUDED_PATH_PREFIXES.map(prefix => `${prefix}%`);
  const digesterPlaceholders = allDigestTypes.map(() => '?').join(', ');

  const sql = `
    SELECT d.file_path
    FROM digests d
    JOIN files f ON f.path = d.file_path
    WHERE f.is_folder = 0
      ${exclusionClause ? `AND ${exclusionClause}` : ''}
      AND d.digester IN (${digesterPlaceholders})
      AND d.status IN ('todo', 'failed')
      AND COALESCE(d.attempts, 0) < ?
    GROUP BY d.file_path
    ORDER BY COALESCE(f.last_scanned_at, f.created_at) ASC
    LIMIT ?
  `;

  const rows = db
    .prepare(sql)
    .all(...exclusionArgs, ...allDigestTypes, MAX_DIGEST_ATTEMPTS, limit) as Array<{ file_path: string }>;

  const paths = rows.map(r => r.file_path);
  log.debug({ count: paths.length }, 'files needing digestion');
  return paths;
}
