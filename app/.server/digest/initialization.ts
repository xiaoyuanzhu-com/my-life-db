/**
 * Digest System Initialization
 * Registers all digesters and syncs digest records
 */

import { globalDigesterRegistry } from './registry';
import { UrlCrawlerDigester } from './digesters/url-crawler';
import { UrlCrawlSummaryDigester } from './digesters/url-crawl-summary';
import { DocToMarkdownDigester } from './digesters/doc-to-markdown';
import { DocToScreenshotDigester } from './digesters/doc-to-screenshot';
import { SpeechRecognitionDigester } from './digesters/speech-recognition';
import { SpeakerEmbeddingDigester } from './digesters/speaker-embedding';
import { ImageOcrDigester } from './digesters/image-ocr';
import { ImageCaptioningDigester } from './digesters/image-captioning';
import { TagsDigester } from './digesters/tags';
import { SearchKeywordDigester } from './digesters/search-keyword';
import { SearchSemanticDigester } from './digesters/search-semantic';
import { ensureAllDigestersForExistingFiles } from './ensure';
import { getLogger } from '~/.server/log/logger';

const log = getLogger({ module: 'DigestInit' });

/**
 * Initialize the digest system
 * - Registers all digesters in dependency order
 * - Syncs digest records for new digesters
 *
 * This function is idempotent - safe to call multiple times
 */
export function initializeDigesters(): void {
  // Check if digesters are already registered (survives HMR via globalThis)
  if (globalDigesterRegistry.count() > 0) {
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

  // 3. DocToScreenshotDigester (no dependencies)
  //    Produces: doc-to-screenshot (screenshot image stored in sqlar)
  globalDigesterRegistry.register(new DocToScreenshotDigester());

  // 4. SpeechRecognitionDigester (no dependencies)
  //    Produces: speech-recognition
  globalDigesterRegistry.register(new SpeechRecognitionDigester());

  // 5. SpeakerEmbeddingDigester (depends on speech-recognition)
  //    Produces: speaker-embedding (extracts speaker embeddings and auto-clusters into people)
  globalDigesterRegistry.register(new SpeakerEmbeddingDigester());

  // 6. ImageOcrDigester (no dependencies)
  //    Produces: image-ocr (extracts text from images)
  globalDigesterRegistry.register(new ImageOcrDigester());

  // 7. ImageCaptioningDigester (no dependencies)
  //    Produces: image-captioning (generates captions for images)
  globalDigesterRegistry.register(new ImageCaptioningDigester());

  // 8. SummaryDigester (depends on content-md)
  //    Produces: summary
  globalDigesterRegistry.register(new UrlCrawlSummaryDigester());

  // 9. TagsDigester (depends on content-md, independent of summary)
  //    Produces: tags
  globalDigesterRegistry.register(new TagsDigester());

  // 10. SearchKeywordDigester (depends on content-md, uses summary + tags if available)
  //     Produces: search-keyword
  globalDigesterRegistry.register(new SearchKeywordDigester());

  // 11. SearchSemanticDigester (depends on content-md, uses summary + tags if available)
  //     Produces: search-semantic
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

  log.info({}, 'digest system initialized');
}
