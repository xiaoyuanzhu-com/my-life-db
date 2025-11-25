/**
 * Digest placeholder management
 * Ensures all registered digesters have records for a given file
 */

import { globalDigesterRegistry } from './registry';
import { listDigestsForPath, insertDigestIfMissing, generateDigestId, updateDigest } from '@/lib/db/digests';
import { getDatabase } from '@/lib/db/connection';
import { getLogger } from '@/lib/log/logger';

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
      id: generateDigestId(filePath, type),
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
  const db = getDatabase();
  const rows = db.prepare('SELECT path FROM files WHERE is_folder = 0').all() as Array<{ path: string }>;

  let totalAdded = 0;
  let totalOrphanedSkipped = 0;

  for (const { path } of rows) {
    const { added, orphanedSkipped } = ensureAllDigesters(path);
    totalAdded += added;
    totalOrphanedSkipped += orphanedSkipped;
  }

  log.info(
    { files: rows.length, added: totalAdded, orphanedSkipped: totalOrphanedSkipped },
    'ensured digest placeholders for existing files'
  );
}
