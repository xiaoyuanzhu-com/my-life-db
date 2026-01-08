/**
 * Digest placeholder management
 * Ensures all registered digesters have records for a given file
 */

import { globalDigesterRegistry } from './registry';
import { EXCLUDED_PATH_PREFIXES } from './file-selection';
import { listDigestsForPath, insertDigestIfMissing, updateDigest } from '~/.server/db/digests';
import { listFilePathsForDigestion } from '~/.server/db/files';
import { getLogger } from '~/.server/log/logger';

const log = getLogger({ module: 'DigestEnsure' });

export function ensureAllDigesters(filePath: string): { added: number; orphanedSkipped: number } {
  const digestTypes = globalDigesterRegistry.getAllDigestTypes();
  if (digestTypes.length === 0) {
    return { added: 0, orphanedSkipped: 0 };
  }

  const existing = listDigestsForPath(filePath, { order: 'asc' });
  const existingTypes = new Set(existing.map((d) => d.digester));
  const validTypes = new Set(digestTypes);
  const now = new Date().toISOString();

  let added = 0;
  for (const type of digestTypes) {
    if (existingTypes.has(type)) continue;

    insertDigestIfMissing({
      // ID assigned by DB helper if null/undefined
      id: undefined as any,
      filePath,
      digester: type,
      status: 'todo',
      content: null,
      sqlarName: null,
      error: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    added++;
  }

  let orphanedSkipped = 0;
  for (const digest of existing) {
    if (!validTypes.has(digest.digester) && (digest.status === 'todo' || digest.status === 'failed')) {
      updateDigest(digest.id, {
        status: 'skipped',
        error: 'Digester no longer registered',
        updatedAt: now,
      });
      orphanedSkipped++;
    }
  }

  if (added > 0 || orphanedSkipped > 0) {
    log.info({ filePath, added, orphanedSkipped }, 'ensured digest placeholders');
  } else {
    log.debug({ filePath }, 'digests already ensured');
  }

  return { added, orphanedSkipped };
}

export function ensureAllDigestersForExistingFiles(): void {
  const paths = listFilePathsForDigestion(EXCLUDED_PATH_PREFIXES);

  let totalAdded = 0;
  let totalOrphanedSkipped = 0;

  for (const path of paths) {
    const { added, orphanedSkipped } = ensureAllDigesters(path);
    totalAdded += added;
    totalOrphanedSkipped += orphanedSkipped;
  }

  log.info(
    { files: paths.length, added: totalAdded, orphanedSkipped: totalOrphanedSkipped },
    'ensured digest placeholders for existing files'
  );
}
