/**
 * Task Queue Startup - Initialize task queue and register handlers
 * This file should be imported and called on app startup
 */

import { startWorker } from './worker';
import { registerUrlEnrichmentHandler } from '../inbox/enrichUrlInboxItem';
import { registerInboxSyncHandler, enqueueSyncTask } from '../inbox/syncInboxFiles';
import { registerPostIndexHandler } from '@/lib/inbox/postIndexEnricher';
import { getLogger } from '@/lib/log/logger';
import { acquireProcessLock, setupLockAutoRelease } from '@/lib/utils/processLock';

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

  // Register all task handlers
  registerUrlEnrichmentHandler();
  registerInboxSyncHandler();
  registerPostIndexHandler();

  // TODO: Register other handlers here
  // registerImageCaptionHandler();
  // registerFaceDetectionHandler();
  // registerAudioTranscriptionHandler();

  // Start worker if requested, guarded by cross-process lock
  if (options?.startWorker !== false) {
    (async () => {
      try {
        const { acquired, ownerPid } = await acquireProcessLock('taskqueue-worker');
        if (acquired) {
          setupLockAutoRelease('taskqueue-worker');
          startWorker({
            verbose: options?.verbose ?? false,
            pollIntervalMs: 1000,
            batchSize: 5,
            maxAttempts: 3,
            staleTaskTimeoutSeconds: 300, // 5 minutes
            staleTaskRecoveryIntervalMs: 60_000, // 1 minute
          });
          log.info({}, 'worker started');

          // Enqueue startup tasks
          enqueueSyncTask();
          log.info({}, 'startup sync task enqueued');
        } else {
          log.info({ ownerPid: ownerPid || null }, 'worker start skipped (lock held)');
        }
      } catch (err) {
        log.error({ err }, 'failed to acquire worker lock');
      }
    })();
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
