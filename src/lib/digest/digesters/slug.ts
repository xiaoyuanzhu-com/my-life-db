/**
 * Slug Digester
 * Generates friendly URL slugs from content
 */

import type { Digester } from '../types';
import type { Digest, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { generateSlugFromContentDigest } from '@/lib/digest/content-slug';
import { generateDigestId } from '@/lib/db/digests';
import { getLogger } from '@/lib/log/logger';
import {
  getPrimaryTextContent,
  getSummaryText,
  hasAnyTextSource,
  hasUrlCrawlContent,
} from '@/lib/digest/text-source';

const log = getLogger({ module: 'SlugDigester' });

/**
 * Slug Digester
 * Generates slugs from summary (preferred) or content-md (fallback)
 * Produces: slug
 */
export class SlugDigester implements Digester {
  readonly name = 'slug';

  async canDigest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    const summaryText = getSummaryText(existingDigests);
    if (summaryText && summaryText.trim().length > 0) {
      return true;
    }

    return (
      hasUrlCrawlContent(existingDigests, 20) ||
      hasAnyTextSource(file, existingDigests, { minFileBytes: 20 })
    );
  }

  async digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<Digest[] | null> {
    let sourceText = getSummaryText(existingDigests);
    let sourceType = sourceText ? 'url-crawl-summary' : 'url-digest';

    if (!sourceText) {
      const textSource = await getPrimaryTextContent(filePath, file, existingDigests);
      if (textSource) {
        sourceText = textSource.text;
        sourceType = textSource.source;
      }
    }

    if (!sourceText) {
      return null; // Should not happen if canDigest returned true
    }

    log.info({ filePath, sourceType }, 'generating slug');

    // Generate slug
    const result = generateSlugFromContentDigest(sourceText);

    const now = new Date().toISOString();

    // Create slug digest with metadata
    const slugData = {
      slug: result.slug,
      title: result.title,
      source: result.source,
      generatedFrom: sourceType,
      generatedAt: now,
    };

    return [
      {
        id: generateDigestId(filePath, 'slug'),
        filePath,
        digester: 'slug',
        status: 'completed',
        content: JSON.stringify(slugData),
        sqlarName: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
