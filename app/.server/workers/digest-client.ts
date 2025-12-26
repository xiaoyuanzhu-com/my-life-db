/**
 * Digest Worker Client
 *
 * Main thread interface for communicating with the digest worker.
 * Spawns and manages the worker thread lifecycle.
 */

import { Worker } from 'worker_threads';
import path from 'path';
import { notificationService } from '../notifications/notification-service';
import { getLogger } from '../log/logger';
import type { MainToWorkerMessage, WorkerToMainMessage } from './digest-worker';

const log = getLogger({ module: 'DigestClient' });

// Global worker instance
let worker: Worker | null = null;
let isReady = false;
let isShuttingDown = false;

/**
 * Start the digest worker thread
 */
export function startDigestWorker(): void {
  if (worker) {
    log.warn({}, 'digest worker already running');
    return;
  }

  log.info({}, 'starting digest worker');

  // Resolve the worker script path
  // In development, we need to handle TypeScript compilation
  const workerPath = path.resolve(__dirname, 'digest-worker.js');

  try {
    worker = new Worker(workerPath, {
      // Pass any worker data if needed
      workerData: {},
    });

    worker.on('message', handleWorkerMessage);
    worker.on('error', handleWorkerError);
    worker.on('exit', handleWorkerExit);

    log.debug({ workerPath }, 'worker thread created');
  } catch (error) {
    log.error({ error, workerPath }, 'failed to create worker thread');
    throw error;
  }
}

/**
 * Stop the digest worker thread
 */
export async function stopDigestWorker(): Promise<void> {
  if (!worker) {
    return;
  }

  if (isShuttingDown) {
    log.debug({}, 'worker already shutting down');
    return;
  }

  isShuttingDown = true;
  log.info({}, 'stopping digest worker');

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log.warn({}, 'worker shutdown timeout, forcing termination');
      worker?.terminate();
      worker = null;
      isReady = false;
      isShuttingDown = false;
      resolve();
    }, 10000);

    // Listen for shutdown complete
    const originalHandler = worker?.listenerCount('message') ?? 0;
    worker?.on('message', (msg: WorkerToMainMessage) => {
      if (msg.type === 'shutdown-complete') {
        clearTimeout(timeout);
        worker?.terminate();
        worker = null;
        isReady = false;
        isShuttingDown = false;
        resolve();
      }
    });

    // Send shutdown signal
    sendMessage({ type: 'shutdown' });
  });
}

/**
 * Request digest processing for a file
 */
export function requestDigest(filePath: string, reset = false): void {
  if (!worker || !isReady) {
    log.warn({ filePath }, 'worker not ready, cannot request digest');
    return;
  }

  log.debug({ filePath, reset }, 'requesting digest');
  sendMessage({ type: 'digest', filePath, reset });
}

/**
 * Check if worker is ready
 */
export function isWorkerReady(): boolean {
  return isReady && worker !== null;
}

/**
 * Send message to worker
 */
function sendMessage(message: MainToWorkerMessage): void {
  if (!worker) {
    log.warn({ message }, 'cannot send message, worker not running');
    return;
  }

  worker.postMessage(message);
}

/**
 * Handle messages from worker
 */
function handleWorkerMessage(message: WorkerToMainMessage): void {
  switch (message.type) {
    case 'ready':
      isReady = true;
      log.info({}, 'digest worker ready');
      break;

    case 'inbox-changed':
      // Forward notification to main thread notification service
      notificationService.notify({
        type: 'inbox-changed',
        timestamp: message.timestamp,
      });
      break;

    case 'digest-started':
      log.debug({ filePath: message.filePath }, 'digest started');
      break;

    case 'digest-complete':
      log.debug(
        { filePath: message.filePath, success: message.success },
        'digest complete'
      );
      break;

    case 'shutdown-complete':
      log.info({}, 'worker shutdown complete');
      break;

    default:
      log.warn({ message }, 'unknown message from worker');
  }
}

/**
 * Handle worker errors
 */
function handleWorkerError(error: Error): void {
  log.error({ error }, 'worker error');
}

/**
 * Handle worker exit
 */
function handleWorkerExit(code: number): void {
  log.info({ code }, 'worker exited');
  worker = null;
  isReady = false;

  // Restart worker if it crashed unexpectedly
  if (!isShuttingDown && code !== 0) {
    log.warn({}, 'worker crashed, restarting in 5 seconds');
    setTimeout(() => {
      if (!isShuttingDown) {
        startDigestWorker();
      }
    }, 5000);
  }
}
