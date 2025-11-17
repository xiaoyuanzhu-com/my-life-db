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
  readonly name = 'tagging';

  async canDigest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Check if url-crawl-content digest exists and is completed
    const contentDigest = existingDigests.find((d) => d.digester === 'url-crawl-content');

    if (!contentDigest || contentDigest.status !== 'completed') {
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
    _db: BetterSqlite3.Database
  ): Promise<Digest[] | null> {
    // Get url-crawl-content digest
    const contentDigest = existingDigests.find((d) => d.digester === 'url-crawl-content');
    if (!contentDigest || !contentDigest.content) {
      return null; // Should not happen if canDigest returned true
    }

    // Parse JSON content to get markdown
    let markdown: string;
    try {
      const contentData = JSON.parse(contentDigest.content);
      markdown = contentData.markdown;
    } catch {
      // Fallback for old format (plain markdown)
      markdown = contentDigest.content;
    }

    log.info({ filePath }, 'generating tags');

    // Generate tags
    const result = await generateTagsDigest({ text: markdown });

    const now = new Date().toISOString();

    return [
      {
        id: generateDigestId(filePath, 'tagging'),
        filePath,
        digester: 'tagging',
        status: 'completed',
        content: JSON.stringify({ tags: result.tags }),
        sqlarName: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
