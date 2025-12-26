/**
 * Digest Worker Thread
 *
 * Runs in a separate thread to handle digest processing without blocking the API.
 *
 * Responsibilities:
 * - Receive digest requests from main thread
 * - Run FileSystemWatcher for real-time file detection
 * - Process files through DigestCoordinator
 * - Maintain queue with deduplication
 * - Report progress back to main thread
 */

import { parentPort, workerData } from 'worker_threads';
import { DigestCoordinator } from '../digest/coordinator';
import { initializeDigesters } from '../digest/initialization';
import { findFilesNeedingDigestion } from '../digest/file-selection';
import { startFileSystemWatcher, stopFileSystemWatcher, type FileChangeEvent } from '../scanner/fs-watcher';
import { startPeriodicScanner, stopPeriodicScanner } from '../scanner/library-scanner';
import { resetStaleInProgressDigests } from '../db/digests';
import { cleanupStaleLocks } from '../db/processing-locks';
import { getLogger } from '../log/logger';

const log = getLogger({ module: 'DigestWorker' });

// Message types from main thread
export type MainToWorkerMessage =
  | { type: 'digest'; filePath: string; reset?: boolean }
  | { type: 'shutdown' };

// Message types to main thread
export type WorkerToMainMessage =
  | { type: 'ready' }
  | { type: 'inbox-changed'; timestamp: string }
  | { type: 'digest-started'; filePath: string }
  | { type: 'digest-complete'; filePath: string; success: boolean }
  | { type: 'shutdown-complete' };

// Queue for files to process
const queue = new Set<string>();
const processing = new Set<string>();
let isProcessing = false;
let isShuttingDown = false;

// Configuration
const config = {
  idleSleepMs: 1000,
  staleDigestThresholdMs: 10 * 60 * 1000, // 10 minutes
  staleSweepIntervalMs: 60 * 1000, // 1 minute
};

let lastStaleSweep = 0;

/**
 * Send message to main thread
 */
function postMessage(message: WorkerToMainMessage): void {
  parentPort?.postMessage(message);
}

/**
 * Queue a file for digest processing
 */
function queueFile(filePath: string, reset = false): void {
  if (isShuttingDown) {
    log.debug({ filePath }, 'ignoring queue request during shutdown');
    return;
  }

  // Skip if already queued or processing
  if (processing.has(filePath)) {
    log.debug({ filePath }, 'file already being processed, skipping');
    return;
  }

  if (queue.has(filePath)) {
    log.debug({ filePath }, 'file already queued, skipping');
    return;
  }

  queue.add(filePath);
  log.debug({ filePath, queueSize: queue.size }, 'file queued for processing');

  // Start processing if not already running
  if (!isProcessing) {
    void processLoop();
  }
}

/**
 * Main processing loop
 */
async function processLoop(): Promise<void> {
  if (isProcessing || isShuttingDown) return;
  isProcessing = true;

  const coordinator = new DigestCoordinator();

  while (queue.size > 0 && !isShuttingDown) {
    // Get next file from queue
    const filePath = queue.values().next().value;
    if (!filePath) break;

    queue.delete(filePath);
    processing.add(filePath);

    postMessage({ type: 'digest-started', filePath });

    try {
      log.debug({ filePath }, 'processing file');
      await coordinator.processFile(filePath);
      postMessage({ type: 'digest-complete', filePath, success: true });
      log.debug({ filePath }, 'file processing complete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ filePath, error: message }, 'file processing failed');
      postMessage({ type: 'digest-complete', filePath, success: false });
    } finally {
      processing.delete(filePath);
    }
  }

  isProcessing = false;

  // If there's still work, continue processing
  if (queue.size > 0 && !isShuttingDown) {
    void processLoop();
  }
}

/**
 * Background supervisor loop - finds files needing digestion
 */
async function supervisorLoop(): Promise<void> {
  log.info({}, 'supervisor loop started');

  // Clean up stale locks on startup
  cleanupStaleLocks();

  while (!isShuttingDown) {
    try {
      // Periodically reset stale digests
      maybeResetStaleDigests();

      // Find files needing digestion (only if queue is small)
      if (queue.size < 10) {
        const filesToProcess = findFilesNeedingDigestion(5);
        for (const filePath of filesToProcess) {
          queueFile(filePath);
        }
      }

      // Sleep before next check
      await sleep(config.idleSleepMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ error: message }, 'supervisor loop error');
      await sleep(config.idleSleepMs);
    }
  }

  log.info({}, 'supervisor loop exited');
}

/**
 * Reset stale in-progress digests periodically
 */
function maybeResetStaleDigests(): void {
  const now = Date.now();
  if (now - lastStaleSweep < config.staleSweepIntervalMs) {
    return;
  }

  lastStaleSweep = now;
  const cutoffIso = new Date(now - config.staleDigestThresholdMs).toISOString();
  const resetCount = resetStaleInProgressDigests(cutoffIso);

  if (resetCount > 0) {
    log.warn({ reset: resetCount }, 'reset stale digest rows');
  }
}

/**
 * Handle file change events from watcher
 */
function handleFileChange(event: FileChangeEvent): void {
  const { filePath, isNew, shouldInvalidateDigests } = event;

  log.debug({ filePath, isNew, shouldInvalidateDigests }, 'file change event');

  // Queue for processing
  queueFile(filePath, shouldInvalidateDigests);

  // Notify main thread if inbox changed
  if (filePath.startsWith('inbox/')) {
    postMessage({
      type: 'inbox-changed',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Handle messages from main thread
 */
function handleMessage(message: MainToWorkerMessage): void {
  switch (message.type) {
    case 'digest':
      queueFile(message.filePath, message.reset);
      break;

    case 'shutdown':
      shutdown();
      break;

    default:
      log.warn({ message }, 'unknown message type');
  }
}

/**
 * Graceful shutdown
 */
async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info({}, 'worker shutting down');

  // Stop accepting new work
  queue.clear();

  // Stop file watcher and scanner
  await stopFileSystemWatcher();
  stopPeriodicScanner();

  // Wait for current processing to finish (with timeout)
  const timeout = 5000;
  const start = Date.now();
  while (processing.size > 0 && Date.now() - start < timeout) {
    await sleep(100);
  }

  if (processing.size > 0) {
    log.warn({ remaining: processing.size }, 'shutdown timeout, some files still processing');
  }

  postMessage({ type: 'shutdown-complete' });
  log.info({}, 'worker shutdown complete');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Initialize and start the worker
 */
async function main(): Promise<void> {
  log.info({}, 'digest worker starting');

  // Initialize digesters
  initializeDigesters();

  // Listen for messages from main thread
  parentPort?.on('message', handleMessage);

  // Start file system watcher with custom handler
  startFileSystemWatcher({
    onFileChange: handleFileChange,
    skipNotifications: true, // We handle notifications ourselves
  });

  // Start periodic scanner
  startPeriodicScanner();

  // Start supervisor loop (background polling)
  void supervisorLoop();

  // Signal ready
  postMessage({ type: 'ready' });
  log.info({}, 'digest worker ready');
}

// Start the worker
main().catch(error => {
  log.error({ error }, 'worker failed to start');
  process.exit(1);
});
