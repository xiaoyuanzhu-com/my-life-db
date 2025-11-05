/**
 * Task Queue Startup - Initialize task queue and register handlers
 * This file should be imported and called on app startup
 */

import { startWorker } from './worker';
import { registerUrlEnrichmentHandler } from '@/lib/inbox/enrichUrlInboxItem';
import { registerUrlSummaryHandler } from '@/lib/inbox/summarizeUrlInboxItem';
import { registerUrlTaggingHandler } from '@/lib/inbox/tagUrlInboxItem';
import { registerUrlSlugHandler } from '@/lib/inbox/slugUrlInboxItem';
// import { registerInboxSyncHandler, enqueueSyncTask } from '../inbox/syncInboxFiles';
// import { registerPostIndexHandler } from '@/lib/inbox/postIndexEnricher';
import { getLogger } from '@/lib/log/logger';
// import { acquireProcessLock, setupLockAutoRelease } from '@/lib/utils/processLock';

let initialized = false;
const log = getLogger({ module: 'TaskQueueStartup' });

/**
 * Initialize task queue system
 * Call this once on app startup
 */
export function initializeTaskQueue(options?: {
  verbose?: boolean;
  startWorker?: boolean;
}) {
  if (initialized) {
    log.info({}, 'already initialized');
    return;
  }

  log.info({}, 'initializing');

  // Register task handlers
  registerUrlEnrichmentHandler();
  registerUrlSummaryHandler();
  registerUrlTaggingHandler();
  registerUrlSlugHandler();

  // Start worker unless explicitly disabled
  if (options?.startWorker !== false) {
    startWorker({
      verbose: options?.verbose ?? false,
      pollIntervalMs: 1000,
      batchSize: 5,
      maxAttempts: 3,
      staleTaskTimeoutSeconds: 300,
      staleTaskRecoveryIntervalMs: 60_000,
    });
    log.info({}, 'worker started');
  }

  initialized = true;
  log.info({}, 'initialization complete');
}

/**
 * Check if task queue is initialized
 */
export function isTaskQueueInitialized(): boolean {
  return initialized;
}
