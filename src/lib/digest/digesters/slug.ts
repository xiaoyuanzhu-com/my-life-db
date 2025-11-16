/**
 * Slug Digester
 * Generates friendly URL slugs from content
 */

import type { Digester, FileRow } from '../types';
import type { Digest } from '@/types';
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
  readonly id = 'slug';
  readonly name = 'Slug Generator';
  readonly produces = ['slug'];
  readonly requires = ['summary', 'content-md']; // Prefers summary, falls back to content

  async canDigest(
    filePath: string,
    file: FileRow,
    existingDigests: Digest[],
    db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Need either summary or content-md
    const summaryDigest = existingDigests.find((d) => d.digestType === 'summary');
    const contentDigest = existingDigests.find((d) => d.digestType === 'content-md');

    const hasSummary = summaryDigest?.status === 'enriched' && !!summaryDigest.content;
    const hasContent = contentDigest?.status === 'enriched' && !!contentDigest.content;

    return hasSummary || hasContent;
  }

  async digest(
    filePath: string,
    file: FileRow,
    existingDigests: Digest[],
    db: BetterSqlite3.Database
  ): Promise<Digest[] | null> {
    // Prefer summary, fallback to content-md
    const summaryDigest = existingDigests.find((d) => d.digestType === 'summary');
    const contentDigest = existingDigests.find((d) => d.digestType === 'content-md');

    const sourceText =
      summaryDigest?.content && summaryDigest.status === 'enriched'
        ? summaryDigest.content
        : contentDigest?.content;

    if (!sourceText) {
      return null; // Should not happen if canDigest returned true
    }

    const sourceType = summaryDigest?.content ? 'summary' : 'content-md';

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
        digestType: 'slug',
        status: 'enriched',
        content: JSON.stringify(slugData),
        sqlarName: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
