/**
 * Digest System Initialization
 * Registers all digesters and syncs digest records
 */

import { globalDigesterRegistry } from './registry';
import { UrlCrawlerDigester } from './digesters/url-crawler';
import { UrlCrawlSummaryDigester } from './digesters/url-crawl-summary';
import { DocToMarkdownDigester } from './digesters/doc-to-markdown';
import { SpeechRecognitionDigester } from './digesters/speech-recognition';
import { TagsDigester } from './digesters/tags';
import { SlugDigester } from './digesters/slug';
import { SearchKeywordDigester } from './digesters/search-keyword';
import { SearchSemanticDigester } from './digesters/search-semantic';
import { ensureAllDigestersForExistingFiles } from './ensure';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'DigestInit' });

let initialized = false;

/**
 * Initialize the digest system
 * - Registers all digesters in dependency order
 * - Syncs digest records for new digesters
 *
 * This function is idempotent - safe to call multiple times
 */
export function initializeDigesters(): void {
  if (initialized) {
    log.debug({}, 'digesters already initialized');
    return;
  }

  log.info({}, 'initializing digest system');

  // Register digesters in dependency order
  // Order matters! Digesters execute in registration order.

  // 1. UrlCrawlerDigester (no dependencies)
  //    Produces: content-md, content-html, screenshot, url-metadata
  globalDigesterRegistry.register(new UrlCrawlerDigester());

  // 2. DocToMarkdownDigester (no dependencies)
  //    Produces: doc-to-markdown
  globalDigesterRegistry.register(new DocToMarkdownDigester());

  // 3. SpeechRecognitionDigester (no dependencies)
  //    Produces: speech-recognition
  globalDigesterRegistry.register(new SpeechRecognitionDigester());

  // 4. SummaryDigester (depends on content-md)
  //    Produces: summary
  globalDigesterRegistry.register(new UrlCrawlSummaryDigester());

  // 5. TagsDigester (depends on content-md, independent of summary)
  //    Produces: tags
  globalDigesterRegistry.register(new TagsDigester());

  // 6. SlugDigester (prefers summary, falls back to content-md)
  //    Produces: slug
  globalDigesterRegistry.register(new SlugDigester());

  // 7. SearchKeywordDigester (depends on content-md, uses summary + tags if available)
  //    Produces: search-keyword
  globalDigesterRegistry.register(new SearchKeywordDigester());

  // 8. SearchSemanticDigester (depends on content-md, uses summary + tags if available)
  //    Produces: search-semantic
  globalDigesterRegistry.register(new SearchSemanticDigester());

  log.info({ count: globalDigesterRegistry.count() }, 'digesters registered');

  // Register task handlers (imported above causes defineTaskHandler to execute)
  // This is a side effect of importing task-handler.ts
  log.info({}, 'task handlers registered');

  // Backfill digest records for all existing files
  try {
    ensureAllDigestersForExistingFiles();
  } catch (error) {
    log.error({ error }, 'failed to ensure digest records');
    // Don't throw - allow initialization to continue
  }

  initialized = true;
  log.info({}, 'digest system initialized');
}

/**
 * Reset initialization state (for testing)
 */
export function resetDigesterInitialization(): void {
  initialized = false;
}
