import 'server-only';
/**
 * URL Inbox Item Enricher - Orchestrates URL crawling and enrichment
 */

import { generateId } from '../fs/storage';
import { getInboxItemById, updateInboxItem } from '../db/inbox';
import { crawlUrlDigest, type UrlCrawlOutput } from '@/lib/digest/url-crawl';
import { processHtmlContent as enrichHtmlContent, extractMainContent, sanitizeContent } from '../crawl/contentEnricher';
import { tq } from '../task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { upsertInboxTaskState } from '../db/inboxTaskState';
import { getLogger } from '@/lib/log/logger';
import type { DigestPipelinePayload, UrlDigestPipelineStage } from '@/types/digest-workflow';
import { enqueueUrlSummary } from './summarizeUrlInboxItem';
import { enqueueUrlTagging } from './tagUrlInboxItem';
import { enqueueUrlSlug } from './slugUrlInboxItem';
import { createDigest, deleteDigestsForItem } from '../db/digests';
import { sqlarStore, sqlarDeletePrefix } from '../db/sqlar';
import { getDatabase } from '../db/connection';

const log = getLogger({ module: 'URLEnricher' });

export interface UrlEnrichmentPayload extends DigestPipelinePayload {
  itemId: string;
  url: string;
}

export interface UrlEnrichmentResult {
  success: boolean;
  error?: string;
}

/**
 * Enrich a URL item (task handler)
 * This function is registered as a task handler and executed by the worker
 */
export async function enrichUrlInboxItem(
  payload: UrlEnrichmentPayload
): Promise<UrlEnrichmentResult> {
  const { itemId, url, pipeline, remainingStages } = payload;

  try {
    // 1. Get item
    const item = getInboxItemById(itemId);
    if (!item) {
      throw new Error(`Item ${itemId} not found`);
    }

    // 2. Update status to enriching
    updateInboxItem(itemId, {
      status: 'enriching',
      enrichedAt: new Date().toISOString(),
    });

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

    // Clear existing digests for this item
    deleteDigestsForItem(itemId);
    sqlarDeletePrefix(db, `${itemId}/`);

    // Save content.md (markdown) to database as text digest
    if (processed.markdown && processed.markdown.trim().length > 0) {
      createDigest({
        id: `${itemId}-content-md`,
        itemId: itemId,
        digestType: 'content-md',
        status: 'completed',
        content: processed.markdown,
        sqlarName: null,
        createdAt: now,
        updatedAt: now,
      });
      log.debug({ itemId }, 'saved content.md digest');
    }

    // Save content.html to SQLAR (binary storage with compression)
    if (html && html.trim().length > 0) {
      const sqlarName = `${itemId}/content-html/content.html`;
      await sqlarStore(db, sqlarName, html);

      createDigest({
        id: `${itemId}-content-html`,
        itemId: itemId,
        digestType: 'content-html',
        status: 'completed',
        content: null,
        sqlarName,
        createdAt: now,
        updatedAt: now,
      });
      log.debug({ itemId, sqlarName }, 'saved content.html digest to SQLAR');
    }

    // Save screenshot to SQLAR
    const screenshot = crawlResult.screenshot;
    if (screenshot?.base64) {
      try {
        const screenshotBuffer = Buffer.from(screenshot.base64, 'base64');
        if (screenshotBuffer.length > 0) {
          const screenshotExtension = getScreenshotExtension(screenshot.mimeType);
          const sqlarName = `${itemId}/screenshot/screenshot.${screenshotExtension}`;

          await sqlarStore(db, sqlarName, screenshotBuffer);

          createDigest({
            id: `${itemId}-screenshot`,
            itemId: itemId,
            digestType: 'screenshot',
            status: 'completed',
            content: null,
            sqlarName,
            createdAt: now,
            updatedAt: now,
          });
          log.info({
            itemId,
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
      id: `${itemId}-url-metadata`,
      itemId: itemId,
      digestType: 'url-metadata',
      status: 'completed',
      content: JSON.stringify(urlMetadata),
      sqlarName: null,
      createdAt: now,
      updatedAt: now,
    });

    // 6. Update item status
    updateInboxItem(itemId, {
      status: 'enriched',
      enrichedAt: new Date().toISOString(),
      error: null,
    });

    log.info({ url }, 'url enriched successfully');

    if (pipeline && Array.isArray(remainingStages) && remainingStages.length > 0) {
      const [nextStage, ...rest] = remainingStages;
      queueNextStage(itemId, nextStage, rest);
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    log.error({ url, error: errorMessage }, 'url enrichment failed');

    // Update item with error
    updateInboxItem(itemId, {
      status: 'failed',
      error: errorMessage,
      enrichedAt: new Date().toISOString(),
    });

    throw new Error(errorMessage);
  }
}

/**
 * Enqueue URL enrichment task
 * This is what you call to trigger URL enrichment
 */
export function enqueueUrlEnrichment(
  itemId: string,
  url: string,
  options?: DigestPipelinePayload
): string {
  ensureTaskRuntimeReady(['digest_url_crawl']);
  const taskId = tq('digest_url_crawl').add({
    itemId,
    url,
    pipeline: options?.pipeline ?? false,
    remainingStages: options?.remainingStages ?? [],
  });

  log.info({ itemId, url, taskId }, 'url enrichment task enqueued');

  // Update projection for quick status checks
  upsertInboxTaskState({
    itemId: itemId,
    taskType: 'digest_url_crawl',
    status: 'to-do',
    taskId,
    attempts: 0,
    error: null,
  });

  return taskId;
}

// Register task handler definition
defineTaskHandler({
  type: 'digest_url_crawl',
  module: 'URLEnricher',
  handler: enrichUrlInboxItem,
});

function queueNextStage(
  itemId: string,
  nextStage: UrlDigestPipelineStage,
  remaining: UrlDigestPipelineStage[]
): void {
  switch (nextStage) {
    case 'summary':
      enqueueUrlSummary(itemId, { pipeline: true, remainingStages: remaining });
      break;
    case 'tagging':
      // Should not happen directly after crawl, but guard anyway
      enqueueUrlTagging(itemId, { pipeline: true, remainingStages: remaining });
      break;
    case 'slug':
      enqueueUrlSlug(itemId, { pipeline: true, remainingStages: remaining });
      break;
    default:
      log.warn({ itemId, stage: nextStage }, 'unknown next stage in url digest pipeline');
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
