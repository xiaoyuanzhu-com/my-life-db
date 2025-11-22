/**
 * URL Crawl Summary Digester
 * Generates summaries from crawled web content
 */

import type { Digester } from '../types';
import type { Digest, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { summarizeTextDigest } from '@/lib/digest/text-summary';
import { generateDigestId } from '@/lib/db/digests';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'UrlCrawlSummaryDigester' });
const toTimestamp = (value?: string | null) => value ? new Date(value).getTime() : 0;

/**
 * URL Crawl Summary Digester
 * Generates summaries from url-crawl-content digest
 */
export class UrlCrawlSummaryDigester implements Digester {
  readonly name = 'url-crawl-summary';

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

    // Only summarize if content is substantial
    const content = contentDigest.content;
    if (!content || content.length < 100) {
      return false; // Too short to summarize
    }

    return true;
  }

  async shouldReprocessCompleted(
    _filePath: string,
    _file: FileRecordRow,
    existingDigests: Digest[]
  ): Promise<boolean> {
    const summaryDigest = existingDigests.find((d) => d.digester === 'url-crawl-summary');
    if (!summaryDigest) {
      return false;
    }

    const contentDigest = existingDigests.find(
      (d) => d.digester === 'url-crawl-content' && d.status === 'completed'
    );

    if (!contentDigest) {
      return false;
    }

    return toTimestamp(contentDigest.updatedAt) > toTimestamp(summaryDigest.updatedAt);
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

    log.debug({ filePath }, 'generating summary');

    // Generate summary (uses default settings from summarizeTextDigest)
    const result = await summarizeTextDigest({ text: markdown });

    const now = new Date().toISOString();

    return [
      {
        id: generateDigestId(filePath, 'url-crawl-summary'),
        filePath,
        digester: 'url-crawl-summary',
        status: 'completed',
        content: JSON.stringify({ summary: result.summary }),
        sqlarName: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
