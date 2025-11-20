/**
 * Tags Digester
 * Generates AI tags for content
 */

import type { Digester } from '../types';
import type { Digest, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { generateTagsDigest } from '@/lib/digest/tags';
import { generateDigestId } from '@/lib/db/digests';
import { getLogger } from '@/lib/log/logger';
import { getPrimaryTextContent, hasAnyTextSource } from '@/lib/digest/text-source';

const log = getLogger({ module: 'TagsDigester' });

/**
 * Tags Digester
 * Generates tags from content-md digest
 * Produces: tags
 */
export class TagsDigester implements Digester {
  readonly name = 'tags';

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
        id: generateDigestId(filePath, 'tags'),
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
}
