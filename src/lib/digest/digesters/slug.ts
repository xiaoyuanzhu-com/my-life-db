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
const toTimestamp = (value?: string | null) => value ? new Date(value).getTime() : 0;

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

    log.debug({ filePath, sourceType }, 'generating slug');

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
    const slugDigest = existingDigests.find((d) => d.digester === 'slug');
    if (!slugDigest || (slugDigest.status !== 'completed' && slugDigest.status !== 'skipped')) {
      return false;
    }

    if (!hasAnyTextSource(file, existingDigests)) {
      return false;
    }

    const summaryDigest =
      existingDigests.find((d) => d.digester === 'url-crawl-summary' && d.status === 'completed') ||
      existingDigests.find((d) => d.digester === 'summarize' && d.status === 'completed');

    const contentDigest = existingDigests.find(
      (d) => d.digester === 'url-crawl-content' && d.status === 'completed'
    );

    const sourceUpdatedAt = summaryDigest
      ? toTimestamp(summaryDigest.updatedAt)
      : contentDigest
        ? toTimestamp(contentDigest.updatedAt)
        : toTimestamp(file.modified_at);

    return sourceUpdatedAt > toTimestamp(slugDigest.updatedAt);
  }
}
