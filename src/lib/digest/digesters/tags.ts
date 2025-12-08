/**
 * Tags Digester
 * Generates AI tags for content
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { generateTagsDigest } from '@/lib/digest/tags';
import { getLogger } from '@/lib/log/logger';
import { getPrimaryTextContent, hasAnyTextSource } from '@/lib/digest/text-source';

const log = getLogger({ module: 'TagsDigester' });
const toTimestamp = (value?: string | null) => value ? new Date(value).getTime() : 0;

/**
 * Tags Digester
 * Generates tags from content-md digest
 * Produces: tags
 */
export class TagsDigester implements Digester {
  readonly name = 'tags';
  readonly label = 'Tags';
  readonly description = 'Generate AI tags for content organization and categorization';

  async canDigest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Process any text file regardless of size
    return hasAnyTextSource(file, existingDigests);
  }

  async digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<DigestInput[] | null> {
    // Check if we have any text source - throw error if not
    if (!hasAnyTextSource(file, existingDigests)) {
      throw new Error('No text source available for tag generation');
    }

    const textSource = await getPrimaryTextContent(filePath, file, existingDigests);
    if (!textSource) {
      return null;
    }

    const markdown = textSource.text.trim();
    if (markdown.length < 10) {
      return null;
    }

    log.debug({ filePath }, 'generating tags');

    // Generate tags
    const result = await generateTagsDigest({ text: markdown });

    const now = new Date().toISOString();

    return [
      {
        filePath,
        digester: 'tags',
        status: 'completed',
        content: JSON.stringify({ tags: result.tags }),
        sqlarName: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  async shouldReprocessCompleted(
    _filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[]
  ): Promise<boolean> {
    const tagsDigest = existingDigests.find((d) => d.digester === 'tags');
    if (!tagsDigest || (tagsDigest.status !== 'completed' && tagsDigest.status !== 'skipped')) {
      return false;
    }

    if (!hasAnyTextSource(file, existingDigests)) {
      return false;
    }

    const contentDigest = existingDigests.find(
      (d) => d.digester === 'url-crawl-content' && d.status === 'completed'
    );

    const sourceUpdatedAt = contentDigest
      ? toTimestamp(contentDigest.updatedAt)
      : toTimestamp(file.modified_at);

    return sourceUpdatedAt > toTimestamp(tagsDigest.updatedAt);
  }
}
