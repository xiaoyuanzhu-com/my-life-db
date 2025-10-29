/**
 * Task Queue Startup - Initialize task queue and register handlers
 * This file should be imported and called on app startup
 */

import { startWorker } from './worker';
import { registerUrlProcessingHandler } from '../inbox/processUrlInboxItem';

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

  // TODO: Register other handlers here
  // registerImageCaptionHandler();
  // registerFaceDetectionHandler();
  // registerAudioTranscriptionHandler();

  // Start worker if requested
  if (options?.startWorker !== false) {
    startWorker({
      verbose: options?.verbose ?? false,
      pollIntervalMs: 1000,
      batchSize: 5,
      maxAttempts: 3,
      staleTaskTimeoutSeconds: 300, // 5 minutes
      staleTaskRecoveryIntervalMs: 60_000, // 1 minute
    });
    console.log('[TaskQueue] Worker started');
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
