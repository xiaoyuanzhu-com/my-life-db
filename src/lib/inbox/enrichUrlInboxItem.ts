import 'server-only';
/**
 * URL Enricher - Orchestrates URL crawling and enrichment
 */

import { crawlUrlDigest, type UrlCrawlOutput } from '@/lib/digest/url-crawl';
import { processHtmlContent as enrichHtmlContent, extractMainContent, sanitizeContent } from '../crawl/contentEnricher';
import { tq } from '../task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { getLogger } from '@/lib/log/logger';
import type { DigestPipelinePayload, UrlDigestPipelineStage } from '@/types/digest-workflow';
import { enqueueUrlSummary } from './summarizeUrlInboxItem';
import { enqueueUrlTagging } from './tagUrlInboxItem';
import { enqueueUrlSlug } from './slugUrlInboxItem';
import { createDigest, deleteDigestsForPath, generateDigestId } from '../db/digests';
import { sqlarStore, sqlarDeletePrefix } from '../db/sqlar';
import { getDatabase } from '../db/connection';
import { getFileByPath } from '../db/files';

const log = getLogger({ module: 'URLEnricher' });

export interface UrlEnrichmentPayload extends DigestPipelinePayload {
  filePath: string;
  url: string;
}

export interface UrlEnrichmentResult {
  success: boolean;
  error?: string;
}

/**
 * Enrich a URL file (task handler)
 * This function is registered as a task handler and executed by the worker
 */
export async function enrichUrlFile(
  payload: UrlEnrichmentPayload
): Promise<UrlEnrichmentResult> {
  const { filePath, url, pipeline, remainingStages } = payload;

  try {
    // 1. Verify file exists
    const file = getFileByPath(filePath);
    if (!file) {
      throw new Error(`File ${filePath} not found`);
    }

    // 3. Crawl URL
    log.info({ url }, 'crawling url');
    const crawlResult = await crawlUrlDigest({ url, timeoutMs: 30000 });
    const html = crawlResult.html ?? '';
    const serviceMarkdown = crawlResult.markdown ?? null;
    let domain = crawlResult.metadata?.domain;
    if (!domain) {
      try {
        domain = new URL(crawlResult.url).hostname;
      } catch {
        domain = 'unknown';
      }
    }
    const metadata: UrlCrawlOutput['metadata'] = {
      title: crawlResult.metadata?.title,
      description: crawlResult.metadata?.description,
      author: crawlResult.metadata?.author,
      publishedDate: crawlResult.metadata?.publishedDate,
      image: crawlResult.metadata?.image,
      siteName: crawlResult.metadata?.siteName,
      domain,
    };

    // 4. Enrich content
    log.info({ url }, 'enriching content');
    let processed = {
      markdown: serviceMarkdown ?? '',
      cleanText: serviceMarkdown ?? '',
      wordCount: serviceMarkdown ? countWords(serviceMarkdown) : 0,
      readingTimeMinutes: serviceMarkdown ? estimateReadingTimeMinutes(countWords(serviceMarkdown)) : 0,
    };

    if (html && html.trim().length > 0) {
      const mainContent = extractMainContent(html);
      const sanitizedContent = sanitizeContent(mainContent);
      const enriched = enrichHtmlContent(sanitizedContent);
      processed = {
        markdown: enriched.markdown,
        cleanText: enriched.cleanText,
        wordCount: enriched.wordCount,
        readingTimeMinutes: enriched.readingTimeMinutes,
      };
    }

    const normalizedMarkdown = serviceMarkdown ?? processed.markdown ?? processed.cleanText;
    if (normalizedMarkdown && normalizedMarkdown.trim().length > 0) {
      processed.markdown = normalizedMarkdown;
      if (!processed.cleanText || processed.cleanText.trim().length === 0) {
        processed.cleanText = normalizedMarkdown;
      }
      if (!processed.wordCount) {
        processed.wordCount = countWords(normalizedMarkdown);
      }
      if (!processed.readingTimeMinutes) {
        processed.readingTimeMinutes = estimateReadingTimeMinutes(processed.wordCount);
      }
    }

    // 5. Save digests to database
    log.info({ url }, 'saving digests to database');
    const db = getDatabase();
    const now = new Date().toISOString();

    // Clear existing digests for this file
    deleteDigestsForPath(filePath);
    const pathHash = Buffer.from(filePath).toString('base64url').slice(0, 12);
    sqlarDeletePrefix(db, `${pathHash}/`);

    // Save content.md (markdown) to database as text digest
    if (processed.markdown && processed.markdown.trim().length > 0) {
      createDigest({
        id: generateDigestId(filePath, 'content-md'),
        filePath,
        digestType: 'content-md',
        status: 'enriched',
        content: processed.markdown,
        sqlarName: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      });
      log.debug({ filePath }, 'saved content.md digest');
    }

    // Save content.html to SQLAR (binary storage with compression)
    if (html && html.trim().length > 0) {
      const sqlarName = `${pathHash}/content-html/content.html`;
      await sqlarStore(db, sqlarName, html);

      createDigest({
        id: generateDigestId(filePath, 'content-html'),
        filePath,
        digestType: 'content-html',
        status: 'enriched',
        content: null,
        sqlarName,
        error: null,
        createdAt: now,
        updatedAt: now,
      });
      log.debug({ filePath, sqlarName }, 'saved content.html digest to SQLAR');
    }

    // Save screenshot to SQLAR
    const screenshot = crawlResult.screenshot;
    if (screenshot?.base64) {
      try {
        const screenshotBuffer = Buffer.from(screenshot.base64, 'base64');
        if (screenshotBuffer.length > 0) {
          const screenshotExtension = getScreenshotExtension(screenshot.mimeType);
          const sqlarName = `${pathHash}/screenshot/screenshot.${screenshotExtension}`;

          await sqlarStore(db, sqlarName, screenshotBuffer);

          createDigest({
            id: generateDigestId(filePath, 'screenshot'),
            filePath,
            digestType: 'screenshot',
            status: 'enriched',
            content: null,
            sqlarName,
            error: null,
            createdAt: now,
            updatedAt: now,
          });
          log.info({
            filePath,
            sqlarName,
            bufferSize: screenshotBuffer.length,
            extension: screenshotExtension,
            mimeType: screenshot.mimeType
          }, 'saved screenshot digest to SQLAR');
        } else {
          log.warn({}, 'screenshot buffer is empty');
        }
      } catch (error) {
        log.error({ err: error }, 'failed to process screenshot data');
      }
    } else {
      log.warn({ hasScreenshot: Boolean(screenshot), hasBase64: Boolean(screenshot?.base64) }, 'no screenshot in crawl result');
    }

    // Save URL metadata as JSON in database (for quick access)
    const urlMetadata = {
      url: crawlResult.url,
      title: metadata.title,
      description: metadata.description,
      author: metadata.author,
      publishedDate: metadata.publishedDate,
      image: metadata.image,
      siteName: metadata.siteName,
      domain: metadata.domain,
      redirectedTo: crawlResult.redirectedTo ?? null,
      wordCount: processed.wordCount,
      readingTimeMinutes: processed.readingTimeMinutes,
    };

    createDigest({
      id: generateDigestId(filePath, 'url-metadata'),
      filePath,
      digestType: 'url-metadata',
      status: 'enriched',
      content: JSON.stringify(urlMetadata),
      sqlarName: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });

    log.info({ url, filePath }, 'url enriched successfully');

    if (pipeline && Array.isArray(remainingStages) && remainingStages.length > 0) {
      const [nextStage, ...rest] = remainingStages;
      queueNextStage(filePath, nextStage, rest);
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    log.error({ url, filePath, error: errorMessage }, 'url enrichment failed');

    // Create failed digest
    const now = new Date().toISOString();
    createDigest({
      id: generateDigestId(filePath, 'content-md'),
      filePath,
      digestType: 'content-md',
      status: 'failed',
      content: null,
      sqlarName: null,
      error: errorMessage,
      createdAt: now,
      updatedAt: now,
    });

    throw new Error(errorMessage);
  }
}

/**
 * Enqueue URL enrichment task
 * This is what you call to trigger URL enrichment
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 */
export function enqueueUrlEnrichment(
  filePath: string,
  url: string,
  options?: DigestPipelinePayload
): string {
  ensureTaskRuntimeReady(['digest_url_crawl']);
  const taskId = tq('digest_url_crawl').add({
    filePath,
    url,
    pipeline: options?.pipeline ?? false,
    remainingStages: options?.remainingStages ?? [],
  });

  log.info({ filePath, url, taskId }, 'url enrichment task enqueued');

  return taskId;
}

// Register task handler definition
defineTaskHandler({
  type: 'digest_url_crawl',
  module: 'URLEnricher',
  handler: enrichUrlFile,
});

function queueNextStage(
  filePath: string,
  nextStage: UrlDigestPipelineStage,
  remaining: UrlDigestPipelineStage[]
): void {
  switch (nextStage) {
    case 'summary':
      enqueueUrlSummary(filePath, { pipeline: true, remainingStages: remaining });
      break;
    case 'tagging':
      // Should not happen directly after crawl, but guard anyway
      enqueueUrlTagging(filePath, { pipeline: true, remainingStages: remaining });
      break;
    case 'slug':
      enqueueUrlSlug(filePath, { pipeline: true, remainingStages: remaining });
      break;
    default:
      log.warn({ filePath, stage: nextStage }, 'unknown next stage in url digest pipeline');
  }
}

function countWords(text: string): number {
  if (!text) return 0;
  const words = text.trim().split(/\s+/);
  return words.filter(Boolean).length;
}

function estimateReadingTimeMinutes(wordCount: number): number {
  if (!wordCount) return 0;
  const minutes = wordCount / 200; // average adult reading speed
  return Math.max(1, Math.round(minutes));
}

function getScreenshotExtension(mimeType: string): string {
  if (!mimeType) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('bmp')) return 'bmp';
  if (mimeType.includes('tiff')) return 'tiff';
  return 'png';
}
