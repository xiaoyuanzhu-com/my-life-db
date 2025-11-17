/**
 * Database operations for files with digests
 * Returns unified FileWithDigests model for UI components
 */

import { getDatabase } from './connection';
import { getFileByPath, listFiles, type FileRecord } from './files';
import { listDigestsForPath } from './digests';
import type { FileWithDigests, DigestSummary } from '@/types/file-card';

/**
 * Get file with all digests
 * Returns unified model for UI components
 */
export function getFileWithDigests(path: string): FileWithDigests | null {
  const file = getFileByPath(path);
  if (!file) return null;

  const digests = listDigestsForPath(path);

  return enrichFileWithDigests(file, digests);
}

/**
 * List files with digests (for inbox/search)
 */
export function listFilesWithDigests(
  pathPrefix?: string,
  options?: {
    isFolder?: boolean;
    orderBy?: 'path' | 'modified_at' | 'created_at';
    ascending?: boolean;
    limit?: number;
    offset?: number;
    digesters?: string[];  // Only include these digesters
    excludeDigesters?: string[];  // Exclude these digesters
  }
): FileWithDigests[] {
  const files = listFiles(pathPrefix, options);

  return files.map((file) => {
    const digests = listDigestsForPath(file.path, {
      digesters: options?.digesters,
      excludeDigesters: options?.excludeDigesters,
    });
    return enrichFileWithDigests(file, digests);
  });
}

/**
 * Count files matching criteria
 */
export function countFilesWithDigests(pathPrefix?: string, isFolder?: boolean): number {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (pathPrefix) {
    conditions.push('path LIKE ?');
    params.push(`${pathPrefix}%`);
  }

  if (isFolder !== undefined) {
    conditions.push('is_folder = ?');
    params.push(isFolder ? 1 : 0);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `SELECT COUNT(*) as count FROM files ${whereClause}`;

  const row = db.prepare(query).get(...params) as { count: number };
  return row.count;
}

/**
 * Enrich file record with digests
 */
function enrichFileWithDigests(
  file: FileRecord,
  digests: Array<{
    id: string;
    filePath: string;
    digester: string;
    status: string;
    content: string | null;
    sqlarName: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  }>
): FileWithDigests {
  const digestSummaries: DigestSummary[] = digests.map((d) => ({
    type: d.digester,
    status: d.status as DigestSummary['status'],
    content: d.content,
    sqlarName: d.sqlarName,
    error: d.error,
    updatedAt: d.updatedAt,
  }));

  return {
    path: file.path,
    name: file.name,
    isFolder: file.isFolder,
    size: file.size,
    mimeType: file.mimeType,
    hash: file.hash,
    modifiedAt: file.modifiedAt,
    createdAt: file.createdAt,
    digests: digestSummaries,
  };
}
