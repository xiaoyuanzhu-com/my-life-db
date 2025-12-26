/**
 * File System Worker
 *
 * Handles file system monitoring and scanning in a separate thread.
 * - FileSystemWatcher: realtime file change detection
 * - LibraryScanner: periodic full filesystem scan
 */

import { parentPort } from 'worker_threads';
import type { FsWorkerInMessage, FsWorkerOutMessage } from './types';
import { getDatabaseInternal } from '~/.server/db/connection';
import { FileSystemWatcher, type FileChangeEvent } from '~/.server/scanner/fs-watcher';
import { startPeriodicScanner, stopPeriodicScanner } from '~/.server/scanner/library-scanner';
import { getLogger } from '~/.server/log/logger';

const log = getLogger({ module: 'FsWorker' });

if (!parentPort) {
  throw new Error('fs-worker must be run as a worker thread');
}

const port = parentPort;

function send(message: FsWorkerOutMessage): void {
  port.postMessage(message);
}

// Initialize database connection for this worker
log.info({}, 'initializing database connection');
getDatabaseInternal();

// Create file system watcher with custom handlers
const watcher = new FileSystemWatcher({
  skipNotifications: true, // We'll send notifications via postMessage
  onFileChange: (event: FileChangeEvent) => {
    // Forward file change events to main thread (for digest worker)
    send({
      type: 'file-change',
      filePath: event.filePath,
      isNew: event.isNew,
      contentChanged: event.contentChanged,
    });

    // Send inbox-changed notification for inbox files
    if (event.filePath.startsWith('inbox/')) {
      send({
        type: 'inbox-changed',
        timestamp: new Date().toISOString(),
      });
    }
  },
});

// Start services
log.info({}, 'starting file system watcher');
watcher.start();

log.info({}, 'starting periodic scanner');
startPeriodicScanner();

// Signal ready
send({ type: 'ready' });
log.info({}, 'fs worker ready');

// Handle messages from main thread
port.on('message', async (message: FsWorkerInMessage) => {
  switch (message.type) {
    case 'shutdown':
      log.info({}, 'shutdown requested');
      stopPeriodicScanner();
      await watcher.stop();
      send({ type: 'shutdown-complete' });
      process.exit(0);
      break;

    default:
      log.warn({ message }, 'unknown message type');
  }
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  log.error({ err: error }, 'uncaught exception in fs worker');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'unhandled rejection in fs worker');
  process.exit(1);
});
