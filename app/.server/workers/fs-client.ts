/**
 * FS Worker Client
 *
 * Main thread interface for communicating with the FS worker.
 */

import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { notificationService } from '~/.server/notifications/notification-service';
import { getLogger } from '~/.server/log/logger';
import type { FsWorkerInMessage, FsWorkerOutMessage, DigestWorkerInMessage } from './types';

const log = getLogger({ module: 'FsClient' });

let worker: Worker | null = null;
let isReady = false;
let isShuttingDown = false;

// Callback to forward file-change events to digest worker
let onFileChange: ((msg: DigestWorkerInMessage) => void) | null = null;

/**
 * Set callback for forwarding file-change events to digest worker
 */
export function setFileChangeHandler(handler: (msg: DigestWorkerInMessage) => void): void {
  onFileChange = handler;
}

/**
 * Start the FS worker thread
 */
export function startFsWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (worker) {
      log.warn({}, 'fs worker already running');
      resolve();
      return;
    }

    log.info({}, 'starting fs worker');

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const workerPath = path.resolve(__dirname, 'fs-worker.ts');

    try {
      // Use tsx/esm loader to run TypeScript workers
      worker = new Worker(workerPath, {
        execArgv: ['--import', 'tsx/esm'],
      });

      const timeout = setTimeout(() => {
        reject(new Error('FS worker startup timeout'));
      }, 30000);

      worker.on('message', (message: FsWorkerOutMessage) => {
        handleWorkerMessage(message);
        if (message.type === 'ready') {
          clearTimeout(timeout);
          resolve();
        }
      });

      worker.on('error', (error) => {
        log.error({ err: error }, 'fs worker error');
        clearTimeout(timeout);
        reject(error);
      });

      worker.on('exit', (code) => {
        handleWorkerExit(code);
      });

      log.debug({ workerPath }, 'fs worker thread created');
    } catch (error) {
      log.error({ err: error, workerPath }, 'failed to create fs worker');
      reject(error);
    }
  });
}

/**
 * Stop the FS worker thread
 */
export async function stopFsWorker(): Promise<void> {
  if (!worker) {
    return;
  }

  if (isShuttingDown) {
    log.debug({}, 'fs worker already shutting down');
    return;
  }

  isShuttingDown = true;
  log.info({}, 'stopping fs worker');

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log.warn({}, 'fs worker shutdown timeout, forcing termination');
      worker?.terminate();
      worker = null;
      isReady = false;
      isShuttingDown = false;
      resolve();
    }, 10000);

    worker?.on('message', (msg: FsWorkerOutMessage) => {
      if (msg.type === 'shutdown-complete') {
        clearTimeout(timeout);
        worker?.terminate();
        worker = null;
        isReady = false;
        isShuttingDown = false;
        resolve();
      }
    });

    sendMessage({ type: 'shutdown' });
  });
}

/**
 * Check if worker is ready
 */
export function isFsWorkerReady(): boolean {
  return isReady && worker !== null;
}

/**
 * Send message to worker
 */
function sendMessage(message: FsWorkerInMessage): void {
  if (!worker) {
    log.warn({ message }, 'cannot send message, fs worker not running');
    return;
  }

  worker.postMessage(message);
}

/**
 * Handle messages from worker
 */
function handleWorkerMessage(message: FsWorkerOutMessage): void {
  switch (message.type) {
    case 'ready':
      isReady = true;
      log.info({}, 'fs worker ready');
      break;

    case 'inbox-changed':
      // Forward notification to main thread notification service
      notificationService.notify({
        type: 'inbox-changed',
        timestamp: message.timestamp,
      });
      break;

    case 'file-change':
      // Forward to digest worker via callback
      if (onFileChange) {
        onFileChange({
          type: 'file-change',
          filePath: message.filePath,
          isNew: message.isNew,
          contentChanged: message.contentChanged,
        });
      }
      break;

    case 'shutdown-complete':
      log.info({}, 'fs worker shutdown complete');
      break;

    default:
      log.warn({ message }, 'unknown message from fs worker');
  }
}

/**
 * Handle worker exit
 */
function handleWorkerExit(code: number): void {
  log.info({ code }, 'fs worker exited');
  worker = null;
  isReady = false;

  // Restart worker if it crashed unexpectedly
  if (!isShuttingDown && code !== 0) {
    log.warn({}, 'fs worker crashed, restarting in 5 seconds');
    setTimeout(() => {
      if (!isShuttingDown) {
        startFsWorker().catch((err) => {
          log.error({ err }, 'failed to restart fs worker');
        });
      }
    }, 5000);
  }
}
