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
import { enqueuePostIndex } from '@/lib/inbox/postIndexProcessor';
import { getLogger } from '@/lib/log/logger';
import { normalizeWithAI } from '@/lib/inbox/normalizer/ai';
import { isAIAvailable } from '@/lib/ai/provider';

const CURRENT_SCHEMA_VERSION = 1;
const log = getLogger({ module: 'InboxSync' });

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
    log.error({ err: error }, 'failed to create inbox directory');
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
    log.error({ err: error }, 'failed to read inbox directory');
    return result;
  }

  log.info({ count: entries.length }, 'found inbox folders');

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
        log.info({ folderName }, 'skipping empty folder');
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
        log.info({ folderName }, 'skipping folder with subdirectories');
        continue;
      }

      // Process files in folder
      const inboxFiles: InboxFile[] = [];
      const textSamples: Record<string, string> = {};
      let metadataObj: unknown = undefined;

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

          // Capture small samples for AI (text-like files)
          const lower = filename.toLowerCase();
          if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.html') || lower.endsWith('.json')) {
            const text = content.toString('utf-8');
            textSamples[filename] = text.length > 1000 ? text.slice(0, 1000) : text;
          }

          // Parse metadata.json if present
          if (lower === 'metadata.json') {
            try {
              metadataObj = JSON.parse(content.toString('utf-8'));
            } catch {
              // ignore
            }
          }
        } catch (error) {
          log.error({ err: error, filename, folderName }, 'failed to process file');
          result.errors.push({
            folder: folderName,
            error: `Failed to process file: ${filename}`,
          });
        }
      }

      // Skip if no valid files
      if (inboxFiles.length === 0) {
        log.info({ folderName }, 'no valid files in folder');
        continue;
      }

      // Determine message type (will be overridden by AI if available)
      let messageType = determineMessageType(inboxFiles);

      // Ask AI to normalize if available
      let aiType: MessageType | null | undefined = undefined;
      let aiId: string | null | undefined = undefined;
      let aiCreatedAt: string | null | undefined = undefined;
      let aiUpdatedAt: string | null | undefined = undefined;

      try {
        if (await isAIAvailable()) {
          const aiInput = {
            folderName,
            files: inboxFiles.map(f => ({ filename: f.filename, size: f.size, mimeType: f.mimeType, type: f.type })),
            samples: textSamples,
            metadataJson: metadataObj,
          };
          const proposal = await normalizeWithAI(aiInput);
          if (proposal?.normalized) {
            aiType = proposal.normalized.type ?? undefined;
            aiId = proposal.normalized.id ?? undefined;
            aiCreatedAt = proposal.normalized.createdAt ?? undefined;
            aiUpdatedAt = proposal.normalized.updatedAt ?? undefined;
          }
        }
      } catch {
        log.warn({}, 'ai normalization failed, continuing with defaults');
      }

      // Get folder creation time (or use current time as fallback)
      let createdAt: string;
      try {
        const stat = await fs.stat(folderPath);
        createdAt = stat.birthtime.toISOString();
      } catch {
        // If birthtime not available, use current time
        createdAt = new Date().toISOString();
      }

      // Apply AI suggestions
      if (aiType) {
        messageType = aiType;
      }
      if (aiCreatedAt && isValidISODate(aiCreatedAt)) {
        createdAt = aiCreatedAt;
      }
      const updatedAt = aiUpdatedAt && isValidISODate(aiUpdatedAt)
        ? aiUpdatedAt
        : new Date().toISOString();

      // Choose ID: prefer metadata.json id if valid, else AI id if valid, else new UUID
      const candidateMetaId = getIdFromMetadata(metadataObj);
      const id = candidateMetaId
        || (aiId && isValidUUID(aiId) ? aiId : generateId());

      // Create inbox item
      const inboxItem: InboxItem = {
        id,
        folderName,
        type: messageType,
        files: inboxFiles,
        status: 'pending',
        processedAt: null,
        error: null,
        aiSlug: null,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt,
        updatedAt,
      };

      // Save to database
      createInboxRecord(inboxItem);
      result.itemsAdded++;
      log.info({ id: inboxItem.id, folderName, type: inboxItem.type }, 'indexed inbox item');

      // Enqueue post-index processing as independent task
      enqueuePostIndex(inboxItem.id);

    } catch (error) {
      log.error({ err: error, folderName }, 'failed to process inbox folder');
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
      log.info({ id: item.id, version: item.schemaVersion }, 'marked item as having outdated schema');
    }
  }

  return result;
}

/**
 * Run full inbox sync (scan files + check schemas)
 */
export async function syncInboxItems(): Promise<SyncResult> {
  log.info({}, 'starting inbox sync');

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

    log.info({
      foldersScanned: result.foldersScanned,
      itemsAdded: result.itemsAdded,
      itemsMarkedOutdated: result.itemsMarkedOutdated,
      errorCount: result.errors.length,
    }, 'inbox sync complete');

    return result;
  } catch (error) {
    log.error({ err: error }, 'inbox sync failed');
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

  log.info({ taskId }, 'sync task enqueued');
  return taskId;
}

/**
 * Register inbox sync handler (call this on app startup)
 */
export function registerInboxSyncHandler(): void {
  tq('sync_inbox').setWorker(async () => {
    return await syncInboxItems();
  });
  log.info({}, 'inbox sync handler registered');
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

// Validate UUID v4/variant string (basic)
function isValidUUID(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const re = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
  return re.test(value);
}

function isValidISODate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

function getIdFromMetadata(md: unknown): string | null {
  if (!md || typeof md !== 'object') return null;
  const anyMd = md as Record<string, unknown>;
  const id = anyMd['id'];
  return isValidUUID(id) ? (id as string) : null;
}
