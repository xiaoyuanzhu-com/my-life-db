import 'server-only';
/**
 * URL Inbox Item Enricher - Orchestrates URL crawling and enrichment
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getInboxItemById, updateInboxItem } from '../db/inbox';
import { crawlUrlDigest } from '@/lib/digest/url-crawl';
import { processHtmlContent as enrichHtmlContent, extractMainContent, sanitizeContent } from '../crawl/contentEnricher';
import { INBOX_DIR } from '../fs/storage';
import { tq } from '../task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { upsertInboxTaskState } from '../db/inboxTaskState';
import { getLogger } from '@/lib/log/logger';
import type { DigestPipelinePayload, UrlDigestPipelineStage } from '@/types/digest-workflow';
import { enqueueUrlSummary } from './summarizeUrlInboxItem';
import { enqueueUrlTagging } from './tagUrlInboxItem';
import { enqueueUrlSlug } from './slugUrlInboxItem';

const log = getLogger({ module: 'URLEnricher' });

export interface UrlEnrichmentPayload extends DigestPipelinePayload {
  inboxId: string;
  url: string;
}

export interface UrlEnrichmentResult {
  success: boolean;
  error?: string;
}

/**
 * Enrich a URL inbox item (task handler)
 * This function is registered as a task handler and executed by the worker
 */
export async function enrichUrlInboxItem(
  payload: UrlEnrichmentPayload
): Promise<UrlEnrichmentResult> {
  const { inboxId, url, pipeline, remainingStages } = payload;

  try {
    // 1. Get inbox item
    const inboxItem = getInboxItemById(inboxId);
    if (!inboxItem) {
      throw new Error(`Inbox item ${inboxId} not found`);
    }

    // 2. Update status to enriching
    updateInboxItem(inboxId, {
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
    const metadata: CrawlResult['metadata'] = {
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

    // 5. Prepare filesystem paths
    const itemDir = path.join(INBOX_DIR, inboxItem.folderName);
    const digestDir = path.join(itemDir, 'digest');

    // 6. Save files
    log.info({ url }, 'saving files');
    await fs.rm(digestDir, { recursive: true, force: true });
    await fs.mkdir(digestDir, { recursive: true });

    const legacyArtifacts = ['content.html', 'content.md', 'main-content.md'];
    await Promise.all(
      legacyArtifacts.map(async (filename) => {
        const legacyPath = path.join(itemDir, filename);
        try {
          await fs.rm(legacyPath);
        } catch {
          // ignore missing legacy file
        }
      })
    );

    const digestArtifacts: Array<{
      filename: string;
      mimeType: string;
      buffer: Buffer;
      type: 'text' | 'image';
    }> = [];

    if (processed.markdown && processed.markdown.trim().length > 0) {
      digestArtifacts.push({
        filename: 'content.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(processed.markdown, 'utf-8'),
        type: 'text',
      });
    }

    if (html && html.trim().length > 0) {
      digestArtifacts.push({
        filename: 'content.html',
        mimeType: 'text/html',
        buffer: Buffer.from(html, 'utf-8'),
        type: 'text',
      });
    }

    const screenshot = crawlResult.screenshot;
    if (screenshot?.base64) {
      try {
        const screenshotBuffer = Buffer.from(screenshot.base64, 'base64');
        if (screenshotBuffer.length > 0) {
          const screenshotExtension = getScreenshotExtension(screenshot.mimeType);
          log.info({
            bufferSize: screenshotBuffer.length,
            extension: screenshotExtension,
            mimeType: screenshot.mimeType
          }, 'saving screenshot to digest folder');
          digestArtifacts.push({
            filename: `screenshot.${screenshotExtension}`,
            mimeType: screenshot.mimeType,
            buffer: screenshotBuffer,
            type: 'image',
          });
        } else {
          log.warn({}, 'screenshot buffer is empty');
        }
      } catch (error) {
        log.error({ err: error }, 'failed to process screenshot data');
      }
    } else {
      log.warn({ hasScreenshot: Boolean(screenshot), hasBase64: Boolean(screenshot?.base64) }, 'no screenshot in crawl result');
    }

    await Promise.all(
      digestArtifacts.map(async (artifact) => {
        const artifactPath = path.join(digestDir, artifact.filename);
        await fs.writeFile(artifactPath, artifact.buffer);
      })
    );

    // 7. Update files array with enrichment
    const updatedFiles = inboxItem.files
      .filter(file => {
        const lower = file.filename.toLowerCase();
        if (lower.startsWith('digest/')) return false;
        if (lower === 'content.html' || lower === 'content.md' || lower === 'main-content.md') {
          return false;
        }
        return true;
      })
      .map(file => {
      if (file.filename === 'url.txt') {
        return {
          ...file,
          enrichment: {
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
          },
        };
      }
      return file;
    });

    // Add new files to the array
    digestArtifacts.forEach(artifact => {
      const hash = createHash('sha256').update(artifact.buffer).digest('hex');
      updatedFiles.push({
        filename: `digest/${artifact.filename}`,
        size: artifact.buffer.length,
        mimeType: artifact.mimeType,
        type: artifact.type,
        hash,
      });
    });

    // 8. Update inbox item
    updateInboxItem(inboxId, {
      files: updatedFiles,
      status: 'enriched',
      enrichedAt: new Date().toISOString(),
      error: null,
    });

    log.info({ url }, 'url enriched successfully');

    if (pipeline && Array.isArray(remainingStages) && remainingStages.length > 0) {
      const [nextStage, ...rest] = remainingStages;
      queueNextStage(inboxId, nextStage, rest);
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    log.error({ url, error: errorMessage }, 'url enrichment failed');

    // Update inbox item with error
    updateInboxItem(inboxId, {
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
  inboxId: string,
  url: string,
  options?: DigestPipelinePayload
): string {
  ensureTaskRuntimeReady(['digest_url_crawl']);
  const taskId = tq('digest_url_crawl').add({
    inboxId,
    url,
    pipeline: options?.pipeline ?? false,
    remainingStages: options?.remainingStages ?? [],
  });

  log.info({ inboxId, url, taskId }, 'url enrichment task enqueued');

  // Update projection for quick status checks
  upsertInboxTaskState({
    inboxId,
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
  inboxId: string,
  nextStage: UrlDigestPipelineStage,
  remaining: UrlDigestPipelineStage[]
): void {
  switch (nextStage) {
    case 'summary':
      enqueueUrlSummary(inboxId, { pipeline: true, remainingStages: remaining });
      break;
    case 'tagging':
      // Should not happen directly after crawl, but guard anyway
      enqueueUrlTagging(inboxId, { pipeline: true, remainingStages: remaining });
      break;
    case 'slug':
      enqueueUrlSlug(inboxId, { pipeline: true, remainingStages: remaining });
      break;
    default:
      log.warn({ inboxId, stage: nextStage }, 'unknown next stage in url digest pipeline');
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
