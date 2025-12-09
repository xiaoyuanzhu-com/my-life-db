/**
 * File selection logic for digest processing
 * Finds files that need digestion based on digest status
 */

import { globalDigesterRegistry } from './registry';
import { listFilesNeedingDigestion } from '~/lib/db/digests';
import { getLogger } from '~/lib/log/logger';
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
 * @param limit Maximum number of files to return
 * @returns Array of file paths that need digestion
 */
export function findFilesNeedingDigestion(limit: number = 100): string[] {
  const allDigestTypes = globalDigesterRegistry.getAllDigestTypes();

  if (allDigestTypes.length === 0) {
    log.warn({}, 'no digesters registered');
    return [];
  }

  const paths = listFilesNeedingDigestion({
    digesterNames: allDigestTypes,
    excludedPathPrefixes: EXCLUDED_PATH_PREFIXES,
    statuses: ['todo', 'failed'],
    maxAttempts: MAX_DIGEST_ATTEMPTS,
    limit,
  });
  log.debug({ count: paths.length }, 'files needing digestion');
  return paths;
}
