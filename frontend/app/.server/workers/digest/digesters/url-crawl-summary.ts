/**
 * URL Crawl Summary Digester
 * Generates summaries from crawled web content
 *
 * Depends on: url-crawl-content digest (checked in digest(), not canDigest())
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import { summarizeTextDigest } from '../utils/text-summary';
import { getLogger } from '~/.server/log/logger';
import { promises as fs } from 'fs';
import path from 'path';

const log = getLogger({ module: 'UrlCrawlSummaryDigester' });

/**
 * URL Crawl Summary Digester
 * Generates summaries from url-crawl-content digest
 *
 * canDigest checks file type only (is it a URL file?)
 * digest() checks dependency (url-crawl-content must be completed)
 */
export class UrlCrawlSummaryDigester implements Digester {
  readonly name = 'url-crawl-summary';
  readonly label = 'Summary';
  readonly description = 'Generate AI summaries of crawled URL content';

  async canDigest(
    filePath: string,
    file: FileRecordRow,
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Same file type check as url-crawler
    // Only process text files
    if (file.mime_type && !file.mime_type.startsWith('text/')) {
      return false;
    }

    // Read file content and check if it's a URL
    try {
      const fullPath = path.join(process.env.MY_DATA_DIR || './data', filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const trimmed = content.trim();

      return trimmed.startsWith('http://') || trimmed.startsWith('https://');
    } catch (error) {
      log.error({ filePath, error }, 'failed to read file');
      return false;
    }
  }

  async digest(
    filePath: string,
    _file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<DigestInput[]> {
    const now = new Date().toISOString();

    // Check dependency: url-crawl-content must be completed
    const contentDigest = existingDigests.find(
      (d) => d.digester === 'url-crawl-content' && d.status === 'completed'
    );
    if (!contentDigest?.content) {
      // Dependency not ready - throw error (will retry)
      throw new Error('URL crawl content not completed yet');
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

    // Check if content is substantial enough to summarize
    if (!markdown || markdown.length < 100) {
      log.debug({ filePath }, 'content too short to summarize');
      return [
        {
          filePath,
          digester: 'url-crawl-summary',
          status: 'completed',
          content: null, // Too short, but still completed
          sqlarName: null,
          error: null,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        },
      ];
    }

    log.debug({ filePath }, 'generating summary');

    // Generate summary (uses default settings from summarizeTextDigest)
    const result = await summarizeTextDigest({ text: markdown });

    return [
      {
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
