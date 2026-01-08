/**
 * Digest Worker
 *
 * Handles all digest processing in a separate thread.
 * - DigestSupervisor: orchestrates processing loop
 * - DigestCoordinator: processes files through digesters
 */

import { parentPort } from 'worker_threads';
import type { DigestWorkerInMessage, DigestWorkerOutMessage } from '../types';
import { getDatabaseInternal } from '~/.server/db/connection';
import { initializeDigesters } from './initialization';
import { DigestCoordinator } from './coordinator';
import { findFilesNeedingDigestion } from './file-selection';
import { resetStaleInProgressDigests, listDigestsForPath } from '~/.server/db/digests';
import { cleanupStaleLocks, isLocked } from '~/.server/db/processing-locks';
import { ensureAllDigesters } from './ensure';
import { getLogger } from '~/.server/log/logger';

const log = getLogger({ module: 'DigestWorker' });

if (!parentPort) {
  throw new Error('digest-worker must be run as a worker thread');
}

const port = parentPort;

function send(message: DigestWorkerOutMessage): void {
  port.postMessage(message);
}

// Configuration
const CONFIG = {
  startDelayMs: 3_000,
  idleSleepMs: 1_000,
  failureBaseDelayMs: 5_000,
  failureMaxDelayMs: 60_000,
  staleDigestThresholdMs: 10 * 60 * 1000,
  staleSweepIntervalMs: 60 * 1000,
};

// State
let stopped = false;
let consecutiveFailures = 0;
let lastStaleSweep = 0;
const coordinator = new DigestCoordinator();

// Initialize database connection for this worker
log.info({}, 'initializing database connection');
getDatabaseInternal();

// Initialize digesters
log.info({}, 'initializing digesters');
initializeDigesters();

// Clean up stale locks from previous runs
cleanupStaleLocks();

// Signal ready
send({ type: 'ready' });
log.info({}, 'digest worker ready');

// Start processing loop after delay
setTimeout(() => {
  void runProcessingLoop();
}, CONFIG.startDelayMs);

/**
 * Main processing loop
 */
async function runProcessingLoop(): Promise<void> {
  log.info({}, 'digest processing loop started');

  while (!stopped) {
    try {
      maybeResetStaleDigests();

      const filesToProcess = findFilesNeedingDigestion(1);
      const filePath = filesToProcess[0];

      if (!filePath) {
        consecutiveFailures = 0;
        await sleep(CONFIG.idleSleepMs);
        continue;
      }

      // Skip if already locked
      if (isLocked(filePath)) {
        await sleep(CONFIG.idleSleepMs);
        continue;
      }

      log.debug({ filePath }, 'processing file');
      send({ type: 'digest-started', filePath });

      await coordinator.processFile(filePath);

      const success = !hasOutstandingFailures(filePath);
      send({ type: 'digest-complete', filePath, success });

      if (!success) {
        consecutiveFailures++;
        const delay = calculateFailureDelay();
        log.error({ filePath, delayMs: delay }, 'digest failed, backing off');
        await sleep(delay);
        continue;
      }

      consecutiveFailures = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      consecutiveFailures++;
      const delay = calculateFailureDelay();
      log.error({ error: message, delayMs: delay }, 'digest processing failed, backing off');
      await sleep(delay);
    }
  }

  log.info({}, 'digest processing loop exited');
}

/**
 * Process a specific file (triggered by message)
 * @param filePath - Relative path from DATA_ROOT
 * @param reset - If true, reset digests before processing
 * @param digester - If provided, only reset and reprocess this specific digester
 */
async function processFile(filePath: string, reset = false, digester?: string): Promise<void> {
  try {
    // Ensure digest placeholders exist
    ensureAllDigesters(filePath);

    send({ type: 'digest-started', filePath });
    await coordinator.processFile(filePath, { reset, digester });

    const success = !hasOutstandingFailures(filePath);
    send({ type: 'digest-complete', filePath, success });
  } catch (error) {
    log.error({ err: error, filePath }, 'failed to process file');
    send({ type: 'digest-complete', filePath, success: false });
  }
}

/**
 * Handle file change event from FS worker
 */
async function handleFileChange(filePath: string, isNew: boolean, contentChanged: boolean): Promise<void> {
  try {
    if (isNew) {
      // New file - ensure placeholders and process
      ensureAllDigesters(filePath);
    }

    if (!isNew && contentChanged) {
      // Content changed - reset and reprocess
      log.info({ filePath }, 'file content changed, invalidating digests');
      await coordinator.processFile(filePath, { reset: true });
      return;
    }

    // Check if file needs processing
    const filesToProcess = findFilesNeedingDigestion(100);
    if (filesToProcess.includes(filePath)) {
      log.info({ filePath, isNew }, 'processing file from watcher event');
      await coordinator.processFile(filePath);
    }
  } catch (error) {
    log.error({ err: error, filePath }, 'failed to handle file change');
  }
}

function maybeResetStaleDigests(): void {
  const now = Date.now();
  if (now - lastStaleSweep < CONFIG.staleSweepIntervalMs) {
    return;
  }

  lastStaleSweep = now;
  const cutoffIso = new Date(now - CONFIG.staleDigestThresholdMs).toISOString();
  const resetCount = resetStaleInProgressDigests(cutoffIso);

  if (resetCount > 0) {
    log.warn({ reset: resetCount }, 'reset stale digest rows');
  }
}

function hasOutstandingFailures(filePath: string): boolean {
  const digests = listDigestsForPath(filePath);
  return digests.some((digest) => digest.status === 'failed');
}

function calculateFailureDelay(): number {
  const exponent = Math.max(consecutiveFailures - 1, 0);
  const delay = CONFIG.failureBaseDelayMs * Math.pow(2, exponent);
  return Math.min(delay, CONFIG.failureMaxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Handle messages from main thread
port.on('message', async (message: DigestWorkerInMessage) => {
  switch (message.type) {
    case 'digest':
      await processFile(message.filePath, message.reset, message.digester);
      break;

    case 'file-change':
      await handleFileChange(message.filePath, message.isNew, message.contentChanged);
      break;

    case 'shutdown':
      log.info({}, 'shutdown requested');
      stopped = true;
      // Give loop time to exit
      setTimeout(() => {
        send({ type: 'shutdown-complete' });
        process.exit(0);
      }, 100);
      break;

    default:
      log.warn({ message }, 'unknown message type');
  }
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  log.error({ err: error }, 'uncaught exception in digest worker');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'unhandled rejection in digest worker');
  process.exit(1);
});
