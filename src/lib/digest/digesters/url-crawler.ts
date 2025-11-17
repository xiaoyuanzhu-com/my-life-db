/**
 * URL Crawler Digester
 * Crawls URLs and produces content digests
 */

import type { Digester } from '../types';
import type { Digest, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { crawlUrlDigest } from '@/lib/digest/url-crawl';
import { processHtmlContent, extractMainContent, sanitizeContent } from '@/lib/crawl/content-enricher';
import { sqlarStore } from '@/lib/db/sqlar';
import { generateDigestId } from '@/lib/db/digests';
import { getLogger } from '@/lib/log/logger';
import { promises as fs } from 'fs';
import path from 'path';

const log = getLogger({ module: 'UrlCrawlerDigester' });

/**
 * Helper functions
 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function estimateReadingTimeMinutes(wordCount: number): number {
  const wordsPerMinute = 200;
  return Math.max(1, Math.ceil(wordCount / wordsPerMinute));
}

function getScreenshotExtension(mimeType: string | undefined): string {
  if (!mimeType) return 'png';
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  return 'png';
}

function hashPath(filePath: string): string {
  return Buffer.from(filePath).toString('base64url').slice(0, 12);
}

/**
 * URL Crawler Digester
 * Detects URL files and crawls them to produce:
 * - content-md (markdown content)
 * - content-html (original HTML)
 * - screenshot (page screenshot)
 * - url-metadata (title, description, etc.)
 */
export class UrlCrawlerDigester implements Digester {
  readonly name = 'url-crawl';

  async canDigest(
    filePath: string,
    file: FileRecordRow,
    _existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
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
    _existingDigests: Digest[],
    db: BetterSqlite3.Database
  ): Promise<Digest[] | null> {
    // Read URL from file
    const fullPath = path.join(process.env.MY_DATA_DIR || './data', filePath);
    const url = (await fs.readFile(fullPath, 'utf-8')).trim();

    log.info({ filePath, url }, 'crawling url');

    // Crawl URL
    const crawlResult = await crawlUrlDigest({ url, timeoutMs: 30000 });
    const html = crawlResult.html ?? '';
    const serviceMarkdown = crawlResult.markdown ?? null;

    // Extract domain
    let domain = crawlResult.metadata?.domain;
    if (!domain) {
      try {
        domain = new URL(crawlResult.url).hostname;
      } catch {
        domain = 'unknown';
      }
    }

    // Process content
    let processed = {
      markdown: serviceMarkdown ?? '',
      wordCount: serviceMarkdown ? countWords(serviceMarkdown) : 0,
      readingTimeMinutes: serviceMarkdown ? estimateReadingTimeMinutes(countWords(serviceMarkdown)) : 0,
    };

    if (html && html.trim().length > 0) {
      const mainContent = extractMainContent(html);
      const sanitizedContent = sanitizeContent(mainContent);
      const enriched = processHtmlContent(sanitizedContent);
      processed = {
        markdown: enriched.markdown,
        wordCount: enriched.wordCount,
        readingTimeMinutes: enriched.readingTimeMinutes,
      };
    }

    const normalizedMarkdown = serviceMarkdown ?? processed.markdown;
    if (normalizedMarkdown && normalizedMarkdown.trim().length > 0) {
      processed.markdown = normalizedMarkdown;
      if (!processed.wordCount) {
        processed.wordCount = countWords(normalizedMarkdown);
      }
      if (!processed.readingTimeMinutes) {
        processed.readingTimeMinutes = estimateReadingTimeMinutes(processed.wordCount);
      }
    }

    // Build digests array
    const digests: Digest[] = [];
    const now = new Date().toISOString();
    const pathHash = hashPath(filePath);

    // 1. url-crawl-content digest (JSON format with markdown + metadata)
    if (processed.markdown && processed.markdown.trim().length > 0) {
      const contentData = {
        markdown: processed.markdown,
        url: crawlResult.url,
        title: crawlResult.metadata?.title,
        description: crawlResult.metadata?.description,
        author: crawlResult.metadata?.author,
        publishedDate: crawlResult.metadata?.publishedDate,
        image: crawlResult.metadata?.image,
        siteName: crawlResult.metadata?.siteName,
        domain,
        wordCount: processed.wordCount,
        readingTimeMinutes: processed.readingTimeMinutes,
      };

      digests.push({
        id: generateDigestId(filePath, 'url-crawl-content'),
        filePath,
        digester: 'url-crawl-content',
        status: 'completed',
        content: JSON.stringify(contentData),
        sqlarName: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      });
      log.debug({ filePath }, 'created url-crawl-content digest');
    }

    // 2. url-crawl-screenshot digest (stored in SQLAR)
    const screenshot = crawlResult.screenshot;
    if (screenshot?.base64) {
      try {
        const screenshotBuffer = Buffer.from(screenshot.base64, 'base64');
        if (screenshotBuffer.length > 0) {
          const screenshotExtension = getScreenshotExtension(screenshot.mimeType);
          const sqlarName = `${pathHash}/url-crawl-screenshot/screenshot.${screenshotExtension}`;

          await sqlarStore(db, sqlarName, screenshotBuffer);

          digests.push({
            id: generateDigestId(filePath, 'url-crawl-screenshot'),
            filePath,
            digester: 'url-crawl-screenshot',
            status: 'completed',
            content: null,
            sqlarName,
            error: null,
            createdAt: now,
            updatedAt: now,
          });
          log.info({ filePath, sqlarName }, 'created url-crawl-screenshot digest');
        }
      } catch (error) {
        log.error({ error }, 'failed to process screenshot');
      }
    }

    log.info({ filePath, digestCount: digests.length }, 'url crawl complete');

    return digests;
  }
}
