/**
 * Digest System Initialization
 * Registers all digesters and syncs digest records
 */

import { globalDigesterRegistry } from './registry';
import { UrlCrawlerDigester } from './digesters/url-crawler';
import { SummaryDigester } from './digesters/summary';
import { TaggingDigester } from './digesters/tagging';
import { SlugDigester } from './digesters/slug';
import { MeiliSearchDigester } from './digesters/search-meili';
import { QdrantSearchDigester } from './digesters/search-qdrant';
import { syncNewDigestTypes } from './sync';
import { getDatabase } from '@/lib/db/connection';
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

  // 2. SummaryDigester (depends on content-md)
  //    Produces: summary
  globalDigesterRegistry.register(new SummaryDigester());

  // 3. TaggingDigester (depends on content-md, independent of summary)
  //    Produces: tags
  globalDigesterRegistry.register(new TaggingDigester());

  // 4. SlugDigester (prefers summary, falls back to content-md)
  //    Produces: slug
  globalDigesterRegistry.register(new SlugDigester());

  // 5. MeiliSearchDigester (depends on content-md, uses summary + tags if available)
  //    Produces: search-meili
  globalDigesterRegistry.register(new MeiliSearchDigester());

  // 6. QdrantSearchDigester (depends on content-md, uses summary + tags if available)
  //    Produces: search-qdrant
  globalDigesterRegistry.register(new QdrantSearchDigester());

  log.info({ count: globalDigesterRegistry.count() }, 'digesters registered');

  // Register task handlers (imported above causes defineTaskHandler to execute)
  // This is a side effect of importing task-handler.ts
  log.info({}, 'task handlers registered');

  // Sync digest records for files that were processed before new digesters were added
  try {
    const db = getDatabase();
    syncNewDigestTypes(db);
  } catch (error) {
    log.error({ error }, 'failed to sync digest records');
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
