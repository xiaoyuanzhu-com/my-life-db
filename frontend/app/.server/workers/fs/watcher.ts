// File system watcher for real-time file detection
// Watches DATA_ROOT for file/folder changes, updates files table, triggers digest processing

import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { DATA_ROOT } from '~/.server/fs/storage';
import { upsertFileRecord, getFileByPath } from '~/.server/db/files';
import { notificationService } from '~/.server/notifications/notification-service';
import { deleteFile } from '~/.server/fs/delete-file';
import { getLogger } from '~/.server/log/logger';
import { isTextFile } from '~/lib/file-types';

const log = getLogger({ module: 'FileSystemWatcher' });

// Reserved folders that should not be watched (same as scanner)
const RESERVED_FOLDERS = ['app', '.app', '.git', '.mylifedb', 'node_modules'];

// Hash files smaller than 10MB (same as scanner)
const HASH_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10MB

// Chokidar stabilization threshold - wait for file writes to complete
const STABILITY_THRESHOLD_MS = 500;

export interface FileChangeEvent {
  filePath: string; // Relative path from DATA_ROOT
  eventType: 'add' | 'change';
  isNew: boolean; // True if file never existed in DB before
  contentChanged: boolean; // True if file content changed (hash changed)
  shouldInvalidateDigests: boolean; // True if digests should be reset
}

export interface FileSystemWatcherOptions {
  /** Custom handler for file change events (instead of EventEmitter) */
  onFileChange?: (event: FileChangeEvent) => void;
  /** Skip calling notificationService (for worker thread mode) */
  skipNotifications?: boolean;
}

/**
 * File system watcher service
 * Emits 'file-change' events when files are added or modified
 *
 * Design principles:
 * 1. Filesystem is source of truth - always check actual file state
 * 2. Per-path serialization - events for same path processed sequentially
 * 3. No application debounce - rely on chokidar's awaitWriteFinish
 */
export class FileSystemWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  // Per-path promise chain to serialize events for the same path
  private pathQueues = new Map<string, Promise<void>>();
  private options: FileSystemWatcherOptions;

  constructor(options: FileSystemWatcherOptions = {}) {
    super();
    this.options = options;
  }

  /**
   * Start watching the data directory
   */
  start(): void {
    if (this.watcher) {
      log.warn({}, 'file system watcher already running');
      return;
    }

    log.info({ dataRoot: DATA_ROOT, reservedFolders: RESERVED_FOLDERS }, 'starting file system watcher');

    this.watcher = chokidar.watch(DATA_ROOT, {
      ignored: (filePath: string) => {
        // Convert to relative path for checking
        const relativePath = path.relative(DATA_ROOT, filePath);

        // Ignore reserved folders
        const firstSegment = relativePath.split(path.sep)[0];
        if (RESERVED_FOLDERS.includes(firstSegment)) {
          log.debug({ filePath: relativePath, reason: 'reserved folder' }, 'ignoring file');
          return true;
        }

        // Ignore hidden files
        const basename = path.basename(filePath);
        if (basename.startsWith('.')) {
          log.debug({ filePath: relativePath, reason: 'hidden file' }, 'ignoring file');
          return true;
        }

        return false;
      },
      persistent: true,
      ignoreInitial: true, // Don't emit for existing files on startup
      awaitWriteFinish: {
        stabilityThreshold: STABILITY_THRESHOLD_MS,
        pollInterval: 100,
      },
      depth: undefined, // Watch all nested directories
    });

    // Listen for file events - all events go through unified handler
    this.watcher
      .on('add', filePath => this.queuePathProcessing(filePath))
      .on('change', filePath => this.queuePathProcessing(filePath))
      .on('unlink', filePath => this.queuePathProcessing(filePath))
      .on('unlinkDir', filePath => this.queuePathProcessing(filePath))
      .on('error', error => {
        log.error({ err: error }, 'file system watcher error');
      })
      .on('ready', () => {
        log.info({}, 'file system watcher ready');
      });
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (!this.watcher) {
      return;
    }

    log.debug({}, 'stopping file system watcher');

    await this.watcher.close();
    this.watcher = null;
    this.pathQueues.clear();

    log.debug({}, 'file system watcher stopped');
  }

  /**
   * Queue path processing to ensure events for the same path are serialized.
   * Different paths can process in parallel.
   */
  private queuePathProcessing(fullPath: string): void {
    const relativePath = path.relative(DATA_ROOT, fullPath);

    log.debug({ path: relativePath }, 'queuing path for processing');

    // Get existing queue for this path, or start with resolved promise
    const existingQueue = this.pathQueues.get(relativePath) ?? Promise.resolve();

    // Chain new processing onto the queue
    const newQueue = existingQueue
      .then(() => this.processPath(relativePath, fullPath))
      .catch(error => {
        log.error({ err: error, path: relativePath }, 'error in path processing queue');
      });

    this.pathQueues.set(relativePath, newQueue);

    // Clean up completed queues to prevent memory leak
    newQueue.finally(() => {
      // Only delete if this is still the current queue (no new events queued)
      if (this.pathQueues.get(relativePath) === newQueue) {
        this.pathQueues.delete(relativePath);
      }
    });
  }

  /**
   * Process a path by checking filesystem state.
   * This is the unified handler for add/change/delete events.
   * Filesystem is source of truth - we check if file exists.
   */
  private async processPath(relativePath: string, fullPath: string): Promise<void> {
    try {
      // Check actual filesystem state
      const exists = await this.fileExists(fullPath);
      const existsInDb = getFileByPath(relativePath) !== null;

      if (exists) {
        await this.processFileExists(relativePath, fullPath, !existsInDb);
      } else {
        await this.processFileDeleted(relativePath, fullPath, existsInDb);
      }
    } catch (error) {
      log.error({ err: error, path: relativePath }, 'failed to process path');
    }
  }

  /**
   * Check if a file/folder exists on disk
   */
  private async fileExists(fullPath: string): Promise<boolean> {
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Process when file exists on filesystem
   */
  private async processFileExists(
    relativePath: string,
    fullPath: string,
    isNew: boolean
  ): Promise<void> {
    log.debug({ path: relativePath, isNew }, 'processing existing file');

    // Get file stats
    const stats = await fs.stat(fullPath);

    // Check if it's a directory (we track folders too)
    if (stats.isDirectory()) {
      upsertFileRecord({
        path: relativePath,
        name: path.basename(relativePath),
        isFolder: true,
        modifiedAt: stats.mtime.toISOString(),
      });
      log.debug({ path: relativePath }, 'indexed folder');
      return;
    }

    // Get existing record for comparison
    const existing = getFileByPath(relativePath);

    // Process regular file
    const filename = path.basename(relativePath);
    const mimeType = this.getMimeType(filename);

    // Hash small files and read text preview
    let hash: string | undefined;
    let textPreview: string | undefined;
    const isText = isTextFile(mimeType, filename);
    if (stats.size < HASH_SIZE_THRESHOLD) {
      const buffer = await fs.readFile(fullPath);
      hash = createHash('sha256').update(buffer).digest('hex');

      // Read text preview for text files (first 50 lines)
      if (isText) {
        const text = buffer.toString('utf-8');
        const lines = text.split('\n').slice(0, 50);
        textPreview = lines.join('\n');
      }
    } else if (isText) {
      // For large text files, still read preview
      try {
        const buffer = await fs.readFile(fullPath, 'utf-8');
        const lines = buffer.split('\n').slice(0, 50);
        textPreview = lines.join('\n');
      } catch {
        // Ignore errors reading text preview
      }
    }

    // Detect if content changed (hash comparison)
    let contentChanged = false;
    if (existing) {
      if (hash && existing.hash) {
        contentChanged = hash !== existing.hash;
      } else if (hash && !existing.hash) {
        contentChanged = true;
      } else if (stats.size !== existing.size) {
        contentChanged = true;
      }
    }

    // Update files table
    upsertFileRecord({
      path: relativePath,
      name: filename,
      isFolder: false,
      size: stats.size,
      mimeType,
      hash,
      modifiedAt: stats.mtime.toISOString(),
      textPreview,
    });

    log.info(
      { path: relativePath, isNew, contentChanged, size: stats.size },
      isNew ? 'new file detected' : contentChanged ? 'file content changed' : 'file metadata updated'
    );

    // Emit notification for inbox files (immediate UI update)
    if (!this.options.skipNotifications && relativePath.startsWith('inbox/')) {
      notificationService.notify({
        type: 'inbox-changed',
        timestamp: new Date().toISOString(),
      });
    }

    // Emit file-change event for digest processing
    const event: FileChangeEvent = {
      filePath: relativePath,
      eventType: isNew ? 'add' : 'change',
      isNew,
      contentChanged,
      shouldInvalidateDigests: contentChanged,
    };

    // Use custom handler if provided, otherwise emit event
    if (this.options.onFileChange) {
      this.options.onFileChange(event);
    } else {
      this.emit('file-change', event);
    }
  }

  /**
   * Process when file no longer exists on filesystem
   */
  private async processFileDeleted(
    relativePath: string,
    fullPath: string,
    existsInDb: boolean
  ): Promise<void> {
    // Skip if file was never in DB (e.g., temp file that was created and deleted quickly)
    if (!existsInDb) {
      log.debug({ path: relativePath }, 'deleted file was not in DB, skipping');
      return;
    }

    try {
      log.info({ path: relativePath }, 'file deletion detected');

      // Check if it's a folder by looking at the DB record
      const existing = getFileByPath(relativePath);
      const isFolder = existing?.isFolder ?? false;

      // Call centralized delete function
      const result = await deleteFile({
        fullPath,
        relativePath,
        isFolder,
      });

      log.info(
        {
          path: relativePath,
          isFolder,
          ...result.databaseRecordsDeleted,
        },
        'file deletion processed'
      );

      // Emit notification for inbox deletions (immediate UI update)
      if (!this.options.skipNotifications && relativePath.startsWith('inbox/')) {
        notificationService.notify({
          type: 'inbox-changed',
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      log.error({ err: error, path: relativePath }, 'failed to process file deletion');
    }
  }

  /**
   * Get MIME type from filename (same logic as scanner)
   */
  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();

    const mimeTypes: Record<string, string> = {
      // Text
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.csv': 'text/csv',

      // Images
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',

      // Audio
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',

      // Video
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',

      // Documents
      '.pdf': 'application/pdf',
    };

    return mimeTypes[ext] || 'application/octet-stream';
  }
}

/**
 * Global watcher instance (singleton)
 */
let globalWatcher: FileSystemWatcher | null = null;

/**
 * Start the file system watcher (singleton)
 */
export function startFileSystemWatcher(options?: FileSystemWatcherOptions): FileSystemWatcher {
  if (!globalWatcher) {
    globalWatcher = new FileSystemWatcher(options);
    globalWatcher.start();
  }
  return globalWatcher;
}

/**
 * Stop the file system watcher
 */
export async function stopFileSystemWatcher(): Promise<void> {
  if (globalWatcher) {
    await globalWatcher.stop();
    globalWatcher = null;
  }
}

/**
 * Get the global watcher instance (for event subscription)
 */
export function getFileSystemWatcher(): FileSystemWatcher | null {
  return globalWatcher;
}
