/**
 * Digest Worker Client
 *
 * Main thread interface for communicating with the digest worker.
 */

import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '~/.server/log/logger';
import type { DigestWorkerInMessage, DigestWorkerOutMessage } from './types';

const log = getLogger({ module: 'DigestClient' });

let worker: Worker | null = null;
let isReady = false;
let isShuttingDown = false;

/**
 * Start the digest worker thread
 */
export function startDigestWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (worker) {
      log.warn({}, 'digest worker already running');
      resolve();
      return;
    }

    log.info({}, 'starting digest worker');

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const workerPath = path.resolve(__dirname, 'digest-worker.js');

    try {
      worker = new Worker(workerPath);

      const timeout = setTimeout(() => {
        reject(new Error('Digest worker startup timeout'));
      }, 30000);

      worker.on('message', (message: DigestWorkerOutMessage) => {
        handleWorkerMessage(message);
        if (message.type === 'ready') {
          clearTimeout(timeout);
          resolve();
        }
      });

      worker.on('error', (error) => {
        log.error({ err: error }, 'digest worker error');
        clearTimeout(timeout);
        reject(error);
      });

      worker.on('exit', (code) => {
        handleWorkerExit(code);
      });

      log.debug({ workerPath }, 'digest worker thread created');
    } catch (error) {
      log.error({ err: error, workerPath }, 'failed to create digest worker');
      reject(error);
    }
  });
}

/**
 * Stop the digest worker thread
 */
export async function stopDigestWorker(): Promise<void> {
  if (!worker) {
    return;
  }

  if (isShuttingDown) {
    log.debug({}, 'digest worker already shutting down');
    return;
  }

  isShuttingDown = true;
  log.info({}, 'stopping digest worker');

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log.warn({}, 'digest worker shutdown timeout, forcing termination');
      worker?.terminate();
      worker = null;
      isReady = false;
      isShuttingDown = false;
      resolve();
    }, 10000);

    worker?.on('message', (msg: DigestWorkerOutMessage) => {
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
 * Request digest processing for a file
 */
export function requestDigest(filePath: string, reset = false): void {
  if (!worker || !isReady) {
    log.warn({ filePath }, 'digest worker not ready, cannot request digest');
    return;
  }

  log.debug({ filePath, reset }, 'requesting digest');
  sendMessage({ type: 'digest', filePath, reset });
}

/**
 * Forward file-change event to digest worker
 */
export function sendFileChange(filePath: string, isNew: boolean, contentChanged: boolean): void {
  if (!worker || !isReady) {
    log.warn({ filePath }, 'digest worker not ready, cannot send file change');
    return;
  }

  sendMessage({ type: 'file-change', filePath, isNew, contentChanged });
}

/**
 * Check if worker is ready
 */
export function isDigestWorkerReady(): boolean {
  return isReady && worker !== null;
}

/**
 * Send message to worker
 */
function sendMessage(message: DigestWorkerInMessage): void {
  if (!worker) {
    log.warn({ message }, 'cannot send message, digest worker not running');
    return;
  }

  worker.postMessage(message);
}

/**
 * Handle messages from worker
 */
function handleWorkerMessage(message: DigestWorkerOutMessage): void {
  switch (message.type) {
    case 'ready':
      isReady = true;
      log.info({}, 'digest worker ready');
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
      log.info({}, 'digest worker shutdown complete');
      break;

    default:
      log.warn({ message }, 'unknown message from digest worker');
  }
}

/**
 * Handle worker exit
 */
function handleWorkerExit(code: number): void {
  log.info({ code }, 'digest worker exited');
  worker = null;
  isReady = false;

  // Restart worker if it crashed unexpectedly
  if (!isShuttingDown && code !== 0) {
    log.warn({}, 'digest worker crashed, restarting in 5 seconds');
    setTimeout(() => {
      if (!isShuttingDown) {
        startDigestWorker().catch((err) => {
          log.error({ err }, 'failed to restart digest worker');
        });
      }
    }, 5000);
  }
}
