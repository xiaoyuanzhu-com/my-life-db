/**
 * Summary Digester
 * Generates AI summaries of content
 */

import type { Digester } from '../types';
import type { Digest, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { summarizeTextDigest } from '@/lib/digest/text-summary';
import { generateDigestId } from '@/lib/db/digests';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'SummaryDigester' });

/**
 * Summary Digester
 * Generates summaries from content-md digest
 * Produces: summary
 */
export class SummaryDigester implements Digester {
  readonly id = 'summarize';
  readonly name = 'Summarizer';
  readonly produces = ['summary'];
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

    // Only summarize if content is substantial
    const content = contentDigest.content;
    if (!content || content.length < 100) {
      return false; // Too short to summarize
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

    log.info({ filePath }, 'generating summary');

    // Generate summary (uses default settings from summarizeTextDigest)
    const result = await summarizeTextDigest({ text: contentDigest.content });

    const now = new Date().toISOString();

    return [
      {
        id: generateDigestId(filePath, 'summary'),
        filePath,
        digestType: 'summary',
        status: 'enriched',
        content: result.summary,
        sqlarName: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
