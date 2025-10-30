import 'server-only';
/**
 * URL Inbox Item Enricher - Orchestrates URL crawling and enrichment
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getInboxItemById, updateInboxItem } from '../db/inbox';
import { crawlUrl } from '../crawl/urlCrawler';
import { processHtmlContent as enrichHtmlContent, extractMainContent, sanitizeContent } from '../crawl/contentEnricher';
import { generateUrlSlug } from '../crawl/urlSlugGenerator';
import { INBOX_DIR } from '../fs/storage';
import { tq } from '../task-queue';
import { upsertInboxTaskState } from '../db/inboxTaskState';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'URLEnricher' });

export interface UrlEnrichmentPayload {
  inboxId: string;
  url: string;
}

export interface UrlEnrichmentResult {
  success: boolean;
  slug?: string;
  title?: string;
  error?: string;
}

/**
 * Enrich a URL inbox item (task handler)
 * This function is registered as a task handler and executed by the worker
 */
export async function enrichUrlInboxItem(
  payload: UrlEnrichmentPayload
): Promise<UrlEnrichmentResult> {
  const { inboxId, url } = payload;

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
    const crawlResult = await crawlUrl(url, {
      timeout: 30000,
      followRedirects: true,
    });

    // 4. Enrich content
    log.info({ url }, 'enriching content');
    const mainContent = extractMainContent(crawlResult.html);
    const sanitizedContent = sanitizeContent(mainContent);
    const processed = enrichHtmlContent(sanitizedContent);

    // 5. Generate slug
    log.info({ url }, 'generating slug');
    const slugResult = await generateUrlSlug(crawlResult);

    // 6. Get item directory
    const itemDir = path.join(INBOX_DIR, inboxItem.folderName);

    // 7. Save files
    log.info({ url }, 'saving files');

    // Save original HTML
    await fs.writeFile(
      path.join(itemDir, 'content.html'),
      crawlResult.html,
      'utf-8'
    );

    // Save markdown
    await fs.writeFile(
      path.join(itemDir, 'content.md'),
      processed.markdown,
      'utf-8'
    );

    // Save main content (cleaned text)
    await fs.writeFile(
      path.join(itemDir, 'main-content.md'),
      processed.cleanText,
      'utf-8'
    );

    // 8. Update files array with enrichment
    const updatedFiles = inboxItem.files.map(file => {
      if (file.filename === 'url.txt') {
        return {
          ...file,
          enrichment: {
            url: crawlResult.url,
            title: crawlResult.metadata.title,
            description: crawlResult.metadata.description,
            author: crawlResult.metadata.author,
            publishedDate: crawlResult.metadata.publishedDate,
            image: crawlResult.metadata.image,
            siteName: crawlResult.metadata.siteName,
            domain: crawlResult.metadata.domain,
            redirectedTo: crawlResult.redirectedTo,
            wordCount: processed.wordCount,
            readingTimeMinutes: processed.readingTimeMinutes,
          },
        };
      }
      return file;
    });

    // Add new files to the array
    updatedFiles.push(
      {
        filename: 'content.html',
        size: Buffer.byteLength(crawlResult.html, 'utf-8'),
        mimeType: 'text/html',
        type: 'text',
        hash: '', // TODO: Calculate hash
      },
      {
        filename: 'content.md',
        size: Buffer.byteLength(processed.markdown, 'utf-8'),
        mimeType: 'text/markdown',
        type: 'text',
        hash: '', // TODO: Calculate hash
      },
      {
        filename: 'main-content.md',
        size: Buffer.byteLength(processed.cleanText, 'utf-8'),
        mimeType: 'text/markdown',
        type: 'text',
        hash: '', // TODO: Calculate hash
      }
    );

    // 9. Rename folder to slug
    const newFolderName = slugResult.slug;
    const newItemDir = path.join(INBOX_DIR, newFolderName);

    // Check if target already exists
    let finalFolderName = newFolderName;
    if (await fs.access(newItemDir).then(() => true).catch(() => false)) {
      // Add suffix to avoid collision
      let counter = 2;
      while (true) {
        const testName = `${newFolderName}-${counter}`;
        const testDir = path.join(INBOX_DIR, testName);
        if (!(await fs.access(testDir).then(() => true).catch(() => false))) {
          finalFolderName = testName;
          break;
        }
        counter++;
      }
    }

    const finalItemDir = path.join(INBOX_DIR, finalFolderName);
    await fs.rename(itemDir, finalItemDir);

    log.info({ from: inboxItem.folderName, to: finalFolderName }, 'renamed folder');

    // 10. Update inbox item
    updateInboxItem(inboxId, {
      folderName: finalFolderName,
      files: updatedFiles,
      aiSlug: slugResult.slug,
      status: 'enriched',
      enrichedAt: new Date().toISOString(),
      error: null,
    });

    log.info({ url }, 'url enriched successfully');

    return {
      success: true,
      slug: slugResult.slug,
      title: slugResult.title,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    log.error({ url, error: errorMessage }, 'url enrichment failed');

    // Update inbox item with error
    updateInboxItem(inboxId, {
      status: 'failed',
      error: errorMessage,
      enrichedAt: new Date().toISOString(),
    });

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Enqueue URL enrichment task
 * This is what you call to trigger URL enrichment
 */
export function enqueueUrlEnrichment(inboxId: string, url: string): string {
  const taskId = tq('process_url').add({
    inboxId,
    url,
  });

  log.info({ inboxId, url, taskId }, 'url enrichment task enqueued');

  // Update projection for quick status checks
  upsertInboxTaskState({
    inboxId,
    taskType: 'process_url',
    status: 'to-do',
    taskId,
    attempts: 0,
    error: null,
  });

  return taskId;
}

/**
 * Register URL enrichment handler (call this on app startup)
 */
export function registerUrlEnrichmentHandler(): void {
  tq('process_url').setWorker(enrichUrlInboxItem);
  log.info({}, 'url enrichment handler registered');
}
