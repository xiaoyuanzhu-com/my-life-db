// File system watcher for real-time file detection
// Watches DATA_ROOT for file/folder changes, updates files table, triggers digest processing

import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { DATA_ROOT } from '~/.server/fs/storage';
import { upsertFileRecord, getFileByPath } from '~/.server/db/files';
import { ensureAllDigesters } from '~/.server/digest/ensure';
import { notificationService } from '~/.server/notifications/notification-service';
import { deleteFile } from '~/.server/files/delete-file';
import { getLogger } from '~/.server/log/logger';
import { isTextFile } from '~/lib/file-types';

const log = getLogger({ module: 'FileSystemWatcher' });

// Reserved folders that should not be watched (same as scanner)
const RESERVED_FOLDERS = ['app', '.app', '.git', '.mylifedb', 'node_modules'];

// Hash files smaller than 10MB (same as scanner)
const HASH_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10MB

// Debounce time to batch rapid file changes
const DEBOUNCE_MS = 500;

export interface FileChangeEvent {
  filePath: string; // Relative path from DATA_ROOT
  eventType: 'add' | 'change';
  isNew: boolean; // True if file never existed in DB before
  contentChanged: boolean; // True if file content changed (hash changed)
  shouldInvalidateDigests: boolean; // True if digests should be reset
}

/**
 * File system watcher service
 * Emits 'file-change' events when files are added or modified
 */
export class FileSystemWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();

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
        stabilityThreshold: DEBOUNCE_MS,
        pollInterval: 100,
      },
      depth: undefined, // Watch all nested directories
    });

    // Listen for file events
    this.watcher
      .on('add', filePath => this.handleFileEvent(filePath, 'add'))
      .on('change', filePath => this.handleFileEvent(filePath, 'change'))
      .on('unlink', filePath => this.handleFileDelete(filePath, false))
      .on('unlinkDir', filePath => this.handleFileDelete(filePath, true))
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

    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    await this.watcher.close();
    this.watcher = null;

    log.debug({}, 'file system watcher stopped');
  }

  /**
   * Handle file add/change events with debouncing
   */
  private handleFileEvent(fullPath: string, eventType: 'add' | 'change'): void {
    // Get relative path from DATA_ROOT
    const relativePath = path.relative(DATA_ROOT, fullPath);

    log.debug({ path: relativePath, eventType }, 'file event received');

    // Clear existing debounce timer
    const existingTimer = this.debounceTimers.get(relativePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(relativePath);
      void this.processFileChange(relativePath, fullPath, eventType);
    }, DEBOUNCE_MS);

    this.debounceTimers.set(relativePath, timer);
  }

  /**
   * Process a file change (after debouncing)
   */
  private async processFileChange(
    relativePath: string,
    fullPath: string,
    eventType: 'add' | 'change'
  ): Promise<void> {
    try {
      log.debug({ path: relativePath, eventType }, 'processing file change');

      // Check if file existed in DB before
      const existing = getFileByPath(relativePath);
      const isNew = !existing;

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
      if (!isNew) {
        // Check if hash changed
        if (hash && existing.hash) {
          // Both hashes exist - compare them
          contentChanged = hash !== existing.hash;
        } else if (hash && !existing.hash) {
          // We have a new hash but no existing hash - assume changed
          // This handles files that were added before hashing was implemented
          contentChanged = true;
        } else if (stats.size !== existing.size) {
          // Fallback: size changed (for large files without hash)
          contentChanged = true;
        }
      }

      // Determine if we should invalidate digests
      const shouldInvalidateDigests = contentChanged;

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

      if (isNew) {
        ensureAllDigesters(relativePath);
      }

      // Emit notification for inbox files (immediate UI update)
      // File changes should update UI immediately, digestion happens in background
      // Note: We notify on any change event, not just contentChanged, because:
      // 1. The watcher only fires on actual file modifications
      // 2. The textPreview in the database is always updated
      // 3. The UI should refresh to show the latest content
      if (relativePath.startsWith('inbox/')) {
        if (isNew) {
          notificationService.notify({
            type: 'inbox-created',
            path: relativePath,
            timestamp: new Date().toISOString(),
          });
        } else {
          // Always notify on file modification for inbox files
          // This ensures UI refresh even if content hash couldn't be compared
          notificationService.notify({
            type: 'inbox-updated',
            path: relativePath,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Emit file-change event for digest processing
      const event: FileChangeEvent = {
        filePath: relativePath,
        eventType,
        isNew,
        contentChanged,
        shouldInvalidateDigests,
      };
      this.emit('file-change', event);
    } catch (error) {
      log.error({ err: error, path: relativePath }, 'failed to process file change');
    }
  }

  /**
   * Handle file/folder deletion events
   */
  private async handleFileDelete(fullPath: string, isFolder: boolean): Promise<void> {
    // Get relative path from DATA_ROOT
    const relativePath = path.relative(DATA_ROOT, fullPath);

    // Skip if already cleaned up (e.g., deleted via API)
    // This avoids redundant cleanup when deletion originates from our own code
    const existing = getFileByPath(relativePath);
    if (!existing) {
      log.debug({ path: relativePath }, 'file already deleted from DB, skipping watcher cleanup');
      return;
    }

    try {
      log.info({ path: relativePath, isFolder }, 'file deletion detected');

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
      if (relativePath.startsWith('inbox/')) {
        notificationService.notify({
          type: 'inbox-deleted',
          path: relativePath,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      log.error({ err: error, path: relativePath, isFolder }, 'failed to process file deletion');
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
export function startFileSystemWatcher(): FileSystemWatcher {
  if (!globalWatcher) {
    globalWatcher = new FileSystemWatcher();
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
