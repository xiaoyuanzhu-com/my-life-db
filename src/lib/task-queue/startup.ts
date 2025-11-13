/**
 * Task Queue Startup - Initialize task queue and register handlers
 * This file should be imported and called on app startup
 */

import { startWorker, shutdownWorker } from './worker';
import '@/lib/inbox/enrichUrlInboxItem';
import '@/lib/inbox/summarizeUrlInboxItem';
import '@/lib/inbox/tagUrlInboxItem';
import '@/lib/inbox/slugUrlInboxItem';
import '@/lib/search/meili-tasks';
import '@/lib/search/qdrant-tasks';
import { ensureTaskHandlersRegistered } from '@/lib/task-queue/handler-registry';
import { getLogger } from '@/lib/log/logger';

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
  startWorker?: boolean;
}) {
  log.info({}, 'initializing');

  // Register task handlers defined across modules
  ensureTaskHandlersRegistered();

  // Start worker unless explicitly disabled
  if (options?.startWorker !== false) {
    startWorker({
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
    process.on(signal, async () => {
      log.info({ signal }, 'received shutdown signal, draining task queue');
      await shutdownWorker({
        reason: `signal:${signal}`,
        timeoutMs: 2000  // 2 second timeout for graceful shutdown
      });
      log.info({ signal }, 'task queue drained, exiting');
      process.exit(0);
    });
  });
}
