/**
 * Task Queue Startup - Initialize task queue and register handlers
 * This file should be imported and called on app startup
 */

import { startWorker } from './worker';
import { registerUrlProcessingHandler } from '../inbox/processUrlInboxItem';
import { registerInboxSyncHandler, enqueueSyncTask } from '../inbox/syncInboxFiles';
import { acquireProcessLock, setupLockAutoRelease } from '@/lib/utils/processLock';

let initialized = false;

/**
 * Initialize task queue system
 * Call this once on app startup
 */
export function initializeTaskQueue(options?: {
  verbose?: boolean;
  startWorker?: boolean;
}) {
  if (initialized) {
    console.log('[TaskQueue] Already initialized');
    return;
  }

  console.log('[TaskQueue] Initializing...');

  // Register all task handlers
  registerUrlProcessingHandler();
  registerInboxSyncHandler();

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
          console.log('[TaskQueue] Worker started');

          // Enqueue startup tasks
          enqueueSyncTask();
          console.log('[TaskQueue] Enqueued startup sync task');
        } else {
          console.log(
            ownerPid
              ? `[TaskQueue] Worker start skipped (lock held by pid ${ownerPid})`
              : '[TaskQueue] Worker start skipped (lock held)'
          );
        }
      } catch (err) {
        console.error('[TaskQueue] Failed to acquire worker lock:', err);
      }
    })();
  }

  initialized = true;
  console.log('[TaskQueue] Initialization complete');
}

/**
 * Check if task queue is initialized
 */
export function isTaskQueueInitialized(): boolean {
  return initialized;
}
