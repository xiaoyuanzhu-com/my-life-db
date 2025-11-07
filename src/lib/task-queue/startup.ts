/**
 * Task Queue Startup - Initialize task queue and register handlers
 * This file should be imported and called on app startup
 */

import { startWorker, shutdownWorker } from './worker';
import { registerUrlEnrichmentHandler } from '@/lib/inbox/enrichUrlInboxItem';
import { registerUrlSummaryHandler } from '@/lib/inbox/summarizeUrlInboxItem';
import { registerUrlTaggingHandler } from '@/lib/inbox/tagUrlInboxItem';
import { registerUrlSlugHandler } from '@/lib/inbox/slugUrlInboxItem';
import { registerSearchTaskHandlers } from '@/lib/search/tasks';
// import { registerInboxSyncHandler, enqueueSyncTask } from '../inbox/syncInboxFiles';
// import { registerPostIndexHandler } from '@/lib/inbox/postIndexEnricher';
import { getLogger } from '@/lib/log/logger';
// import { acquireProcessLock, setupLockAutoRelease } from '@/lib/utils/processLock';

declare global {
  var __mylifedb_taskqueue_initialized: boolean | undefined;
  var __mylifedb_taskqueue_shutdown_hooks: boolean | undefined;
}

const globalState = globalThis as typeof globalThis & {
  __mylifedb_taskqueue_initialized?: boolean;
  __mylifedb_taskqueue_shutdown_hooks?: boolean;
};

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
  if (globalState.__mylifedb_taskqueue_initialized) {
    if (process.env.NODE_ENV !== 'production') {
      log.info({}, 'reinitializing task queue (dev hot reload)');
      void shutdownWorker({ reason: 'task-queue reinit', timeoutMs: 2000 });
      globalState.__mylifedb_taskqueue_initialized = false;
    } else {
      log.info({}, 'already initialized');
      return;
    }
  }

  log.info({}, 'initializing');

  // Register task handlers
  registerUrlEnrichmentHandler();
  registerUrlSummaryHandler();
  registerUrlTaggingHandler();
  registerUrlSlugHandler();
  registerSearchTaskHandlers();

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
  globalState.__mylifedb_taskqueue_initialized = true;
  registerShutdownHooks();
  log.info({}, 'initialization complete');
}

/**
 * Check if task queue is initialized
 */
export function isTaskQueueInitialized(): boolean {
  return initialized;
}

function registerShutdownHooks() {
  if (globalState.__mylifedb_taskqueue_shutdown_hooks) {
    return;
  }

  globalState.__mylifedb_taskqueue_shutdown_hooks = true;
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  signals.forEach(signal => {
    process.on(signal, () => {
      log.info({ signal }, 'received shutdown signal, draining task queue');
      void shutdownWorker({ reason: `signal:${signal}` });
    });
  });

  process.on('beforeExit', () => {
    log.info({}, 'process beforeExit, draining task queue');
    void shutdownWorker({ reason: 'beforeExit', timeoutMs: 2000 });
  });
}
