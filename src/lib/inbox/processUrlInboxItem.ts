/**
 * URL Inbox Item Processor - Orchestrates URL crawling and processing
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getInboxItemById, updateInboxItem } from '../db/inbox';
import { crawlUrl } from '../crawl/urlCrawler';
import { processHtmlContent, extractMainContent, sanitizeContent } from '../crawl/contentProcessor';
import { generateUrlSlug } from '../crawl/urlSlugGenerator';
import { INBOX_DIR } from '../fs/storage';
import { tq } from '../task-queue';

export interface UrlProcessingPayload {
  inboxId: string;
  url: string;
}

export interface UrlProcessingResult {
  success: boolean;
  slug?: string;
  title?: string;
  error?: string;
}

/**
 * Process a URL inbox item (task handler)
 * This function is registered as a task handler and executed by the worker
 */
export async function processUrlInboxItem(
  payload: UrlProcessingPayload
): Promise<UrlProcessingResult> {
  const { inboxId, url } = payload;

  try {
    // 1. Get inbox item
    const inboxItem = getInboxItemById(inboxId);
    if (!inboxItem) {
      throw new Error(`Inbox item ${inboxId} not found`);
    }

    // 2. Update status to processing
    updateInboxItem(inboxId, {
      status: 'processing',
      processedAt: new Date().toISOString(),
    });

    // 3. Crawl URL
    console.log(`[URLProcessor] Crawling URL: ${url}`);
    const crawlResult = await crawlUrl(url, {
      timeout: 30000,
      followRedirects: true,
    });

    // 4. Process content
    console.log(`[URLProcessor] Processing content for: ${url}`);
    const mainContent = extractMainContent(crawlResult.html);
    const sanitizedContent = sanitizeContent(mainContent);
    const processed = processHtmlContent(sanitizedContent);

    // 5. Generate slug
    console.log(`[URLProcessor] Generating slug for: ${url}`);
    const slugResult = await generateUrlSlug(crawlResult);

    // 6. Get item directory
    const itemDir = path.join(INBOX_DIR, inboxItem.folderName);

    // 7. Save files
    console.log(`[URLProcessor] Saving files for: ${url}`);

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

    console.log(`[URLProcessor] Renamed folder: ${inboxItem.folderName} → ${finalFolderName}`);

    // 10. Update inbox item
    updateInboxItem(inboxId, {
      folderName: finalFolderName,
      files: updatedFiles,
      aiSlug: slugResult.slug,
      status: 'completed',
      processedAt: new Date().toISOString(),
      error: null,
    });

    console.log(`[URLProcessor] Successfully processed: ${url}`);

    return {
      success: true,
      slug: slugResult.slug,
      title: slugResult.title,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error(`[URLProcessor] Failed to process ${url}:`, errorMessage);

    // Update inbox item with error
    updateInboxItem(inboxId, {
      status: 'failed',
      error: errorMessage,
      processedAt: new Date().toISOString(),
    });

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Enqueue URL processing task
 * This is what you call to trigger URL processing
 */
export function enqueueUrlProcessing(inboxId: string, url: string): string {
  const taskId = tq('process_url').add({
    inboxId,
    url,
  });

  console.log(`[URLProcessor] Enqueued URL processing task ${taskId} for: ${url}`);

  return taskId;
}

/**
 * Register URL processing handler (call this on app startup)
 */
export function registerUrlProcessingHandler(): void {
  tq('process_url').setWorker(processUrlInboxItem);
  console.log('[URLProcessor] Registered URL processing handler');
}
