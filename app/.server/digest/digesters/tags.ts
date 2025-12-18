/**
 * Tags Digester
 * Generates AI tags for content
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import { generateTagsDigest } from '~/.server/digest/tags';
import { getLogger } from '~/.server/log/logger';
import { getPrimaryTextContent } from '~/.server/digest/text-source';

const log = getLogger({ module: 'TagsDigester' });

/**
 * Tags Digester
 * Generates tags from content
 *
 * Always runs for all file types. Completes with tags if text available,
 * completes with null content if no text available (never skips).
 * Cascading resets from upstream digesters trigger re-processing.
 */
export class TagsDigester implements Digester {
  readonly name = 'tags';
  readonly label = 'Tags';
  readonly description = 'Generate AI tags for content organization and categorization';

  async canDigest(
    _filePath: string,
    file: FileRecordRow,
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Always try to run for non-folder files
    // Cascading resets handle re-processing when content becomes available
    return !file.is_folder;
  }

  async digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<DigestInput[]> {
    const now = new Date().toISOString();

    // Check if we have any text content
    const textSource = await getPrimaryTextContent(filePath, file, existingDigests);

    if (!textSource) {
      // No text available - complete with no content (don't skip)
      // Cascading resets will trigger re-processing if content becomes available
      log.debug({ filePath }, 'no text content available for tags');
      return [
        {
          filePath,
          digester: 'tags',
          status: 'completed',
          content: null,
          sqlarName: null,
          error: null,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        },
      ];
    }

    const markdown = textSource.text.trim();
    if (markdown.length < 10) {
      // Text too short - complete with no content
      log.debug({ filePath }, 'text too short for tag generation');
      return [
        {
          filePath,
          digester: 'tags',
          status: 'completed',
          content: null,
          sqlarName: null,
          error: null,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        },
      ];
    }

    log.debug({ filePath, source: textSource.source }, 'generating tags');

    // Generate tags
    const result = await generateTagsDigest({ text: markdown });

    return [
      {
        filePath,
        digester: 'tags',
        status: 'completed',
        content: JSON.stringify({ tags: result.tags, textSource: textSource.source }),
        sqlarName: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
