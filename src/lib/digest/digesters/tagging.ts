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
import { getPrimaryTextContent, hasAnyTextSource } from '@/lib/digest/text-source';

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
    return hasAnyTextSource(file, existingDigests, {
      minUrlLength: 50,
      minFileBytes: 50,
    });
  }

  async digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<Digest[] | null> {
    const textSource = await getPrimaryTextContent(filePath, file, existingDigests);
    if (!textSource) {
      return null;
    }

    const markdown = textSource.text.trim();
    if (markdown.length < 10) {
      return null;
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
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
