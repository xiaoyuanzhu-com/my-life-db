import 'server-only';
/**
 * Inbox File System Sync - Scan inbox folders and sync with database
 *
 * Ensures consistency between file system and database by:
 * 1. Adding files from folders that exist on disk but not in database
 * 2. Marking items with outdated schema versions
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { INBOX_DIR, generateId } from '@/lib/fs/storage';
import { createInboxRecord, listInboxItems, updateInboxItem } from '@/lib/db/inbox';
import type { InboxItem, InboxFile, MessageType, FileType } from '@/types';
import { tq } from '../task-queue';

const CURRENT_SCHEMA_VERSION = 1;

export interface SyncResult {
  foldersScanned: number;
  itemsAdded: number;
  itemsMarkedOutdated: number;
  errors: Array<{ folder: string; error: string }>;
}

/**
 * Scan inbox folders and add missing items to database
 */
async function scanInboxFolders(): Promise<{
  itemsAdded: number;
  foldersScanned: number;
  errors: Array<{ folder: string; error: string }>;
}> {
  const result = {
    itemsAdded: 0,
    foldersScanned: 0,
    errors: [] as Array<{ folder: string; error: string }>,
  };

  // Ensure inbox directory exists
  try {
    await fs.mkdir(INBOX_DIR, { recursive: true });
  } catch (error) {
    console.error('[InboxSync] Failed to create inbox directory:', error);
    return result;
  }

  // Get all existing inbox items from database
  const existingItems = listInboxItems();
  const existingFolderNames = new Set(existingItems.map(item => item.folderName));

  // Scan file system for folders
  let entries: string[];
  try {
    const dirEntries = await fs.readdir(INBOX_DIR, { withFileTypes: true });
    entries = dirEntries
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  } catch (error) {
    console.error('[InboxSync] Failed to read inbox directory:', error);
    return result;
  }

  console.log(`[InboxSync] Found ${entries.length} folders in inbox directory`);

  // Process each folder
  for (const folderName of entries) {
    result.foldersScanned++;

    // Skip if already in database
    if (existingFolderNames.has(folderName)) {
      continue;
    }

    const folderPath = path.join(INBOX_DIR, folderName);

    try {
      // Read folder contents
      const files = await fs.readdir(folderPath);

      // Skip empty folders
      if (files.length === 0) {
        console.log(`[InboxSync] Skipping empty folder: ${folderName}`);
        continue;
      }

      // Check for subdirectories - skip folders with subdirectories
      let hasSubdirs = false;
      for (const file of files) {
        const filePath = path.join(folderPath, file);
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
          hasSubdirs = true;
          break;
        }
      }

      if (hasSubdirs) {
        console.log(`[InboxSync] Skipping folder with subdirectories: ${folderName}`);
        continue;
      }

      // Process files in folder
      const inboxFiles: InboxFile[] = [];

      for (const filename of files) {
        const filePath = path.join(folderPath, filename);

        try {
          const stat = await fs.stat(filePath);
          const content = await fs.readFile(filePath);
          const hash = createHash('sha256').update(content).digest('hex');
          const mimeType = getMimeType(filename);

          inboxFiles.push({
            filename,
            size: stat.size,
            mimeType,
            type: getFileType(mimeType),
            hash,
          });
        } catch (error) {
          console.error(`[InboxSync] Failed to process file ${filename} in ${folderName}:`, error);
          result.errors.push({
            folder: folderName,
            error: `Failed to process file: ${filename}`,
          });
        }
      }

      // Skip if no valid files
      if (inboxFiles.length === 0) {
        console.log(`[InboxSync] No valid files in folder: ${folderName}`);
        continue;
      }

      // Determine message type
      const messageType = determineMessageType(inboxFiles);

      // Get folder creation time (or use current time as fallback)
      let createdAt: string;
      try {
        const stat = await fs.stat(folderPath);
        createdAt = stat.birthtime.toISOString();
      } catch {
        // If birthtime not available, use current time
        createdAt = new Date().toISOString();
      }

      // Create inbox item
      const inboxItem: InboxItem = {
        id: generateId(),
        folderName,
        type: messageType,
        files: inboxFiles,
        status: 'pending',
        processedAt: null,
        error: null,
        aiSlug: null,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt,
        updatedAt: new Date().toISOString(),
      };

      // Save to database
      createInboxRecord(inboxItem);
      result.itemsAdded++;
      console.log(`[InboxSync] Added inbox item for folder: ${folderName}`);

    } catch (error) {
      console.error(`[InboxSync] Failed to process folder ${folderName}:`, error);
      result.errors.push({
        folder: folderName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * Check and mark items with outdated schema versions
 */
function markOutdatedSchemas(): {
  itemsMarkedOutdated: number;
} {
  const result = {
    itemsMarkedOutdated: 0,
  };

  // Get all inbox items
  const items = listInboxItems();

  // Check each item's schema version
  for (const item of items) {
    if (item.schemaVersion < CURRENT_SCHEMA_VERSION) {
      // Mark as outdated by updating the item with a note
      // We don't change the schema version, just add an error field to indicate it's outdated
      updateInboxItem(item.id, {
        error: `Schema outdated: version ${item.schemaVersion} (current: ${CURRENT_SCHEMA_VERSION})`,
      });

      result.itemsMarkedOutdated++;
      console.log(`[InboxSync] Marked item ${item.id} as having outdated schema (v${item.schemaVersion})`);
    }
  }

  return result;
}

/**
 * Run full inbox sync (scan files + check schemas)
 */
export async function syncInboxItems(): Promise<SyncResult> {
  console.log('[InboxSync] Starting inbox sync...');

  try {
    // Phase 1: Scan file system and add missing items
    const scanResult = await scanInboxFolders();

    // Phase 2: Mark items with outdated schemas
    const schemaResult = markOutdatedSchemas();

    const result: SyncResult = {
      foldersScanned: scanResult.foldersScanned,
      itemsAdded: scanResult.itemsAdded,
      itemsMarkedOutdated: schemaResult.itemsMarkedOutdated,
      errors: scanResult.errors,
    };

    console.log('[InboxSync] Sync complete:', {
      foldersScanned: result.foldersScanned,
      itemsAdded: result.itemsAdded,
      itemsMarkedOutdated: result.itemsMarkedOutdated,
      errorCount: result.errors.length,
    });

    return result;
  } catch (error) {
    console.error('[InboxSync] Sync failed:', error);
    throw error;
  }
}

/**
 * Enqueue inbox sync task
 */
export function enqueueSyncTask(): string {
  const taskId = tq('sync_inbox').add({
    timestamp: new Date().toISOString(),
  });

  console.log(`[InboxSync] Enqueued sync task ${taskId}`);
  return taskId;
}

/**
 * Register inbox sync handler (call this on app startup)
 */
export function registerInboxSyncHandler(): void {
  tq('sync_inbox').setWorker(async () => {
    return await syncInboxItems();
  });
  console.log('[InboxSync] Registered inbox sync handler');
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Determine file type from MIME type
 */
function getFileType(mimeType: string): FileType {
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'other';
}

/**
 * Get MIME type from filename
 */
function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();

  const mimeTypes: Record<string, string> = {
    // Text
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.json': 'application/json',
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

/**
 * Determine message type based on files
 */
function determineMessageType(files: InboxFile[]): MessageType {
  // Check for URL type (url.txt file)
  if (files.some(f => f.filename === 'url.txt')) {
    return 'url';
  }

  // Single file determines type
  if (files.length === 1) {
    const file = files[0];
    if (file.type === 'image') return 'image';
    if (file.type === 'audio') return 'audio';
    if (file.type === 'video') return 'video';
    if (file.type === 'pdf') return 'pdf';
    if (file.type === 'text') return 'text';
  }

  // Multiple files or mixed types
  return 'mixed';
}
