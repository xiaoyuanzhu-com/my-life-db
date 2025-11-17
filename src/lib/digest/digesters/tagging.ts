/**
 * Tagging Digester
 * Generates AI tags for content
 */

import type { Digester } from '../types';
import type { Digest, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { generateTagsDigest } from '@/lib/digest/tagging';
import { generateDigestId } from '@/lib/db/digests';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'TaggingDigester' });

/**
 * Tagging Digester
 * Generates tags from content-md digest
 * Produces: tags
 */
export class TaggingDigester implements Digester {
  readonly id = 'tag';
  readonly name = 'Tagger';
  readonly produces = ['tags'];
  readonly requires = ['content-md']; // Needs content first

  async canDigest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Check if content-md digest exists and is enriched
    const contentDigest = existingDigests.find((d) => d.digestType === 'content-md');

    if (!contentDigest || contentDigest.status !== 'enriched') {
      return false; // Skip this time, will retry next run
    }

    // Only tag if content is substantial enough
    const content = contentDigest.content;
    if (!content || content.length < 50) {
      return false; // Too short to tag
    }

    return true;
  }

  async digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    db: BetterSqlite3.Database
  ): Promise<Digest[] | null> {
    // Get content-md digest
    const contentDigest = existingDigests.find((d) => d.digestType === 'content-md');
    if (!contentDigest || !contentDigest.content) {
      return null; // Should not happen if canDigest returned true
    }

    log.info({ filePath }, 'generating tags');

    // Generate tags
    const result = await generateTagsDigest({ text: contentDigest.content });

    const now = new Date().toISOString();

    return [
      {
        id: generateDigestId(filePath, 'tags'),
        filePath,
        digestType: 'tags',
        status: 'enriched',
        content: JSON.stringify({ tags: result.tags }),
        sqlarName: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
