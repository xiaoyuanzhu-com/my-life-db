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
    // Need either summarize or url-crawl-content
    const summaryDigest = existingDigests.find((d) => d.digester === 'summarize');
    const contentDigest = existingDigests.find((d) => d.digester === 'url-crawl-content');

    const hasSummary = summaryDigest?.status === 'completed' && !!summaryDigest.content;
    const hasContent = contentDigest?.status === 'completed' && !!contentDigest.content;

    return hasSummary || hasContent;
  }

  async digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<Digest[] | null> {
    // Prefer summary, fallback to url-crawl-content
    const summaryDigest = existingDigests.find((d) => d.digester === 'summarize');
    const contentDigest = existingDigests.find((d) => d.digester === 'url-crawl-content');

    let sourceText: string | undefined;
    let sourceType: string = 'url-crawl-content'; // Default value

    // Try to get summary first
    if (summaryDigest?.content && summaryDigest.status === 'completed') {
      try {
        const summaryData = JSON.parse(summaryDigest.content);
        sourceText = summaryData.summary;
        sourceType = 'summarize';
      } catch {
        // Fallback for old format
        sourceText = summaryDigest.content;
        sourceType = 'summarize';
      }
    } else if (contentDigest?.content) {
      // Fallback to url-crawl-content
      try {
        const contentData = JSON.parse(contentDigest.content);
        sourceText = contentData.markdown;
        sourceType = 'url-crawl-content';
      } catch {
        // Fallback for old format
        sourceText = contentDigest.content;
        sourceType = 'url-crawl-content';
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
