/**
 * Upload Queue Manager
 *
 * Manages the local-first upload queue with:
 * - Persistent storage in IndexedDB
 * - TUS resumable uploads
 * - Automatic retry with exponential backoff
 * - Multi-tab coordination via heartbeat locks
 * - Network-aware scheduling
 */

import * as tus from 'tus-js-client';
import type { PendingInboxItem } from './types';
import { QUEUE_CONSTANTS, RETRY_DELAYS_MS } from './types';
import {
  openDatabase,
  saveItem,
  getItem,
  deleteItem,
  getAllItems,
  getNextItemAndLock,
  updateHeartbeat,
  updateProgress,
  markUploaded,
  deleteCompletedByPaths,
  requestPersistentStorage,
} from './db';
import { generateTextFilename, deduplicateFilename } from './filename';
import { api } from '~/lib/api';

const {
  MAX_CONCURRENT_UPLOADS,
  SIMPLE_UPLOAD_THRESHOLD,
  HEARTBEAT_INTERVAL_MS,
  UPLOAD_TIMEOUT_MS,
  RETRY_JITTER_PERCENT,
} = QUEUE_CONSTANTS;


type ProgressCallback = (items: PendingInboxItem[]) => void;
type UploadCompleteCallback = (item: PendingInboxItem, serverPath: string) => void;

interface ActiveUpload {
  itemId: string;
  abortController: AbortController;
  tusUpload?: tus.Upload;
  heartbeatInterval?: ReturnType<typeof setInterval>;
}

/**
 * Generate a unique tab ID
 */
function generateTabId(): string {
  return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  // Use crypto.randomUUID if available (modern browsers)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fallback polyfill for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Calculate retry delay with jitter
 */
function getRetryDelay(retryCount: number): number {
  const baseDelay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
  const jitter = baseDelay * RETRY_JITTER_PERCENT * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

/** Throttle interval for progress notifications (ms) */
const PROGRESS_THROTTLE_MS = 100;

export class UploadQueueManager {
  private tabId: string;
  private activeUploads = new Map<string, ActiveUpload>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private onProgressCallbacks: ProgressCallback[] = [];
  private onUploadCompleteCallbacks: UploadCompleteCallback[] = [];
  private initialized = false;
  private progressThrottleTimeout: ReturnType<typeof setTimeout> | null = null;
  private progressPending = false;
  // Mutex to prevent concurrent processNext() calls from racing
  private isProcessing = false;
  private needsReprocess = false;

  constructor() {
    this.tabId = generateTabId();
  }

  /**
   * Initialize the queue manager
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Open database
    await openDatabase();

    // Request persistent storage
    await requestPersistentStorage();

    // Listen for online events
    window.addEventListener('online', this.handleOnline);

    // Start processing
    this.processNext();

    this.initialized = true;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    window.removeEventListener('online', this.handleOnline);

    // Clear all retry timers
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();

    // Abort all active uploads
    for (const upload of this.activeUploads.values()) {
      upload.abortController.abort();
      if (upload.heartbeatInterval) {
        clearInterval(upload.heartbeatInterval);
      }
    }
    this.activeUploads.clear();

    this.initialized = false;
  }

  /**
   * Handle network coming online
   */
  private handleOnline = (): void => {
    console.log('[UploadQueue] Network online, triggering immediate retry');
    this.processNext();
  };

  /**
   * Subscribe to progress updates
   */
  onProgress(callback: ProgressCallback): () => void {
    this.onProgressCallbacks.push(callback);
    return () => {
      const index = this.onProgressCallbacks.indexOf(callback);
      if (index >= 0) {
        this.onProgressCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to upload complete events
   */
  onUploadComplete(callback: UploadCompleteCallback): () => void {
    this.onUploadCompleteCallbacks.push(callback);
    return () => {
      const index = this.onUploadCompleteCallbacks.indexOf(callback);
      if (index >= 0) {
        this.onUploadCompleteCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Notify progress subscribers (throttled to avoid excessive re-renders)
   */
  private async notifyProgress(): Promise<void> {
    // If a notification is already pending, just mark that we need another one
    if (this.progressThrottleTimeout) {
      this.progressPending = true;
      return;
    }

    // Send notification immediately
    await this.doNotifyProgress();

    // Set throttle timeout
    this.progressThrottleTimeout = setTimeout(async () => {
      this.progressThrottleTimeout = null;
      // If there was a pending notification, send it now
      if (this.progressPending) {
        this.progressPending = false;
        await this.doNotifyProgress();
      }
    }, PROGRESS_THROTTLE_MS);
  }

  /**
   * Actually send progress notification to subscribers
   */
  private async doNotifyProgress(): Promise<void> {
    const items = await getAllItems();
    for (const callback of this.onProgressCallbacks) {
      try {
        callback(items);
      } catch (err) {
        console.error('[UploadQueue] Progress callback error:', err);
      }
    }
  }

  /**
   * Notify upload complete subscribers
   */
  private notifyUploadComplete(item: PendingInboxItem, serverPath: string): void {
    for (const callback of this.onUploadCompleteCallbacks) {
      try {
        callback(item, serverPath);
      } catch (err) {
        console.error('[UploadQueue] Upload complete callback error:', err);
      }
    }
  }

  /**
   * Enqueue text content for upload
   */
  async enqueueText(text: string, destination?: string): Promise<PendingInboxItem> {
    const id = generateUUID();
    const now = Date.now();

    // Generate filename
    const generatedName = generateTextFilename(text);
    const baseName = generatedName ?? id;
    const filename = `${baseName}.md`;

    // Create blob from text
    const blob = new Blob([text], { type: 'text/markdown' });

    const item: PendingInboxItem = {
      id,
      createdAt: now,
      filename,
      blob,
      type: 'text/markdown',
      size: blob.size,
      status: 'saved',
      uploadProgress: 0,
      retryCount: 0,
      destination,
    };

    await saveItem(item);
    await this.notifyProgress();

    // Trigger processing
    this.processNext();

    return item;
  }

  /**
   * Enqueue a file for upload
   */
  async enqueueFile(file: File, usedNames?: Set<string>, destination?: string): Promise<PendingInboxItem> {
    const id = generateUUID();
    const now = Date.now();

    // Deduplicate filename if needed
    let filename = file.name;
    if (usedNames) {
      filename = deduplicateFilename(filename, usedNames);
      usedNames.add(filename);
    }

    const item: PendingInboxItem = {
      id,
      createdAt: now,
      filename,
      blob: file,
      type: file.type || 'application/octet-stream',
      size: file.size,
      status: 'saved',
      uploadProgress: 0,
      retryCount: 0,
      destination,
    };

    await saveItem(item);
    await this.notifyProgress();

    // Trigger processing
    this.processNext();

    return item;
  }

  /**
   * Enqueue multiple items (text + files)
   */
  async enqueueAll(
    text: string | undefined,
    files: File[],
    destination?: string
  ): Promise<PendingInboxItem[]> {
    const items: PendingInboxItem[] = [];
    const usedNames = new Set<string>();

    // Enqueue text first (if provided)
    if (text && text.trim()) {
      const textItem = await this.enqueueText(text.trim(), destination);
      items.push(textItem);
      usedNames.add(textItem.filename);
    }

    // Enqueue files
    for (const file of files) {
      const fileItem = await this.enqueueFile(file, usedNames, destination);
      items.push(fileItem);
    }

    return items;
  }

  /**
   * Enqueue multiple files with different destinations (batch, single notification)
   * Used for folder uploads where each file may have a different destination
   */
  async enqueueBatch(
    files: Array<{ file: File; destination: string }>
  ): Promise<PendingInboxItem[]> {
    const items: PendingInboxItem[] = [];
    const usedNames = new Set<string>();

    for (const { file, destination } of files) {
      const id = generateUUID();
      const now = Date.now();

      let filename = file.name;
      // Deduplicate within the batch
      const key = `${destination}/${filename}`;
      if (usedNames.has(key)) {
        filename = deduplicateFilename(filename, usedNames);
      }
      usedNames.add(`${destination}/${filename}`);

      const item: PendingInboxItem = {
        id,
        createdAt: now,
        filename,
        blob: file,
        type: file.type || 'application/octet-stream',
        size: file.size,
        status: 'saved',
        uploadProgress: 0,
        retryCount: 0,
        destination,
      };

      await saveItem(item);
      items.push(item);
    }

    // Single notification after all items are saved
    await this.notifyProgress();

    // Start processing
    this.processNext();

    return items;
  }

  /**
   * Get all pending items (for display)
   */
  async getPendingItems(): Promise<PendingInboxItem[]> {
    return getAllItems();
  }

  /**
   * Cancel/delete an upload
   */
  async cancelUpload(id: string): Promise<void> {
    // Abort if actively uploading
    const active = this.activeUploads.get(id);
    if (active) {
      active.abortController.abort();
      if (active.tusUpload) {
        active.tusUpload.abort(true);
      }
      if (active.heartbeatInterval) {
        clearInterval(active.heartbeatInterval);
      }
      this.activeUploads.delete(id);
    }

    // Clear retry timer
    const timer = this.retryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }

    // Get item to check for TUS URL
    const item = await getItem(id);
    if (item?.tusUploadUrl) {
      // Best-effort cleanup of TUS upload on server
      // Extract path from URL to avoid Mixed Content issues (http vs https)
      try {
        const url = new URL(item.tusUploadUrl);
        await api.delete(url.pathname);
      } catch {
        // Ignore errors - server cleanup is best-effort
      }
    }

    // Delete from IndexedDB
    await deleteItem(id);
    await this.notifyProgress();
  }

  /**
   * Delete completed uploads whose serverPath matches any of the given paths
   * Called by file-tree when real files appear in the tree
   */
  async deleteCompletedUploads(paths: Set<string>): Promise<void> {
    const deletedIds = await deleteCompletedByPaths(paths);
    if (deletedIds.length > 0) {
      await this.notifyProgress();
    }
  }

  /**
   * Process next items from queue (fills up to MAX_CONCURRENT_UPLOADS)
   *
   * Uses a JavaScript mutex to serialize calls, preventing race conditions where
   * concurrent getNextItemAndLock() calls could return the same item before
   * either transaction commits.
   */
  async processNext(): Promise<void> {
    // If already processing, mark that we need to reprocess when done
    if (this.isProcessing) {
      this.needsReprocess = true;
      return;
    }

    this.isProcessing = true;
    try {
      do {
        this.needsReprocess = false;
        await this.doProcessNext();
      } while (this.needsReprocess);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Internal: actually process items (called by processNext with mutex held)
   */
  private async doProcessNext(): Promise<void> {
    // Fill up to max concurrent uploads
    while (this.activeUploads.size < MAX_CONCURRENT_UPLOADS) {
      // Atomically get next item AND lock it in a single DB transaction
      const item = await getNextItemAndLock(this.tabId);

      if (!item) {
        // No more items available to process
        break;
      }

      // Defensive check - should never happen with mutex
      if (this.activeUploads.has(item.id)) {
        console.error('[UploadQueue] Item already in activeUploads:', item.id);
        continue;
      }

      // Track upload in memory for abort/cleanup
      this.activeUploads.set(item.id, {
        itemId: item.id,
        abortController: new AbortController(),
      });

      // Start upload asynchronously (don't await - we want concurrent uploads)
      this.uploadItem(item).catch((err) => {
        // uploadItem handles its own errors, but catch to prevent unhandled rejection
        console.error('[UploadQueue] Unexpected error in uploadItem:', err);
      });
    }
  }

  /**
   * Upload a single item using TUS
   */
  private async uploadItem(item: PendingInboxItem): Promise<void> {
    // Get the activeUpload entry that was created in processNext
    const activeUpload = this.activeUploads.get(item.id);
    if (!activeUpload) {
      console.error('[UploadQueue] Item not found in activeUploads (should not happen):', item.id);
      return;
    }

    // Start heartbeat
    activeUpload.heartbeatInterval = setInterval(() => {
      updateHeartbeat(item.id, this.tabId).catch(console.error);
    }, HEARTBEAT_INTERVAL_MS);

    try {
      // Update item status - clear error and retry info when starting upload
      const updatedItem: PendingInboxItem = {
        ...item,
        status: 'uploading',
        uploadProgress: item.tusUploadOffset ? Math.floor((item.tusUploadOffset / item.size) * 100) : 0,
        lastAttemptAt: Date.now(),
        errorMessage: undefined,
        nextRetryAt: undefined,
      };
      await saveItem(updatedItem);
      await this.notifyProgress();

      // Choose upload strategy: simple PUT for small files, TUS for large files
      const serverPath = updatedItem.size <= SIMPLE_UPLOAD_THRESHOLD
        ? await this.performSimpleUpload(updatedItem, activeUpload)
        : await this.performTusUpload(updatedItem, activeUpload);

      // Success! Mark as uploaded
      // Item stays in DB until real file appears in tree (cleaned up by file-tree.tsx)
      await markUploaded(item.id, serverPath);
      this.notifyUploadComplete(updatedItem, serverPath);
      await this.notifyProgress();

    } catch (err) {
      console.error('[UploadQueue] Upload failed:', err);

      // Check if aborted
      if (activeUpload.abortController.signal.aborted) {
        return;
      }

      // Schedule retry
      await this.scheduleRetry(item, err instanceof Error ? err.message : 'Upload failed');

    } finally {
      // Clean up
      if (activeUpload.heartbeatInterval) {
        clearInterval(activeUpload.heartbeatInterval);
      }
      this.activeUploads.delete(item.id);

      // Process next item
      this.processNext();
    }
  }

  /**
   * Perform simple PUT upload for small files
   * Single request: file body sent directly to server, which saves and registers it.
   */
  private async performSimpleUpload(
    item: PendingInboxItem,
    activeUpload: ActiveUpload
  ): Promise<string> {
    // Build the destination path: destination/filename
    const destination = item.destination ?? 'inbox';
    const uploadPath = destination ? `${destination}/${item.filename}` : item.filename;
    const encodedPath = uploadPath.split('/').map(encodeURIComponent).join('/');

    console.log('[UploadQueue] Starting simple upload:', {
      filename: item.filename,
      destination,
      size: item.size,
    });

    const response = await api.fetch(`/api/upload/simple/${encodedPath}`, {
      method: 'PUT',
      headers: {
        'Content-Type': item.type || 'application/octet-stream',
      },
      body: item.blob,
      signal: activeUpload.abortController.signal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    const result = await response.json();
    const defaultPath = `${destination}/${item.filename}`;
    const finalPath = result.path || result.paths?.[0] || defaultPath;
    const fileStatus = result.results?.[0]?.status;

    console.log('[UploadQueue] Simple upload completed:', {
      destination,
      filename: item.filename,
      resultPath: result.path,
      finalPath,
      status: fileStatus ?? 'created',
      ...(fileStatus === 'skipped' ? { note: 'identical file already exists' } : {}),
    });

    // Update progress to 100% (single request, no streaming progress)
    try {
      await updateProgress(item.id, 100, item.size);
      await this.notifyProgress();
    } catch (err) {
      console.error('[UploadQueue] Failed to update progress:', err);
    }

    return finalPath;
  }

  /**
   * Perform TUS upload
   */
  private performTusUpload(
    item: PendingInboxItem,
    activeUpload: ActiveUpload
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      console.log('[UploadQueue] Starting TUS upload:', {
        filename: item.filename,
        destination: item.destination,
        tusUploadUrl: item.tusUploadUrl,
        size: item.size,
      });

      const upload = new tus.Upload(item.blob, {
        endpoint: '/api/upload/tus/',
        retryDelays: [], // We handle retries ourselves
        chunkSize: 10 * 1024 * 1024, // 10MB chunks
        uploadUrl: item.tusUploadUrl || undefined,
        metadata: {
          filename: item.filename,
          filetype: item.type,
        },
        headers: {
          'Idempotency-Key': item.id,
        },
        onError: async (error) => {
          console.error('[UploadQueue] TUS upload error:', error);

          // If we get a 404 error while trying to resume, clear the stale TUS URL and retry
          if (error.message && error.message.includes('404') && item.tusUploadUrl) {
            console.log('[UploadQueue] Clearing stale TUS URL and retrying with fresh upload');
            const currentItem = await getItem(item.id);
            if (currentItem) {
              await saveItem({ ...currentItem, tusUploadUrl: undefined, tusUploadOffset: undefined });
            }
          }

          reject(error);
        },
        onProgress: async (bytesUploaded, bytesTotal) => {
          const percentage = Math.round((bytesUploaded / bytesTotal) * 100);
          try {
            await updateProgress(item.id, percentage, bytesUploaded);
            await this.notifyProgress();
          } catch (err) {
            console.error('[UploadQueue] Failed to update progress:', err);
          }
        },
        onSuccess: async () => {
          // Upload complete - finalize
          try {
            // Build request body - only include destination if it's defined
            const requestBody: any = {
              uploads: [{
                uploadId: upload.url?.split('/').pop(),
                filename: item.filename,
                size: item.size,
                type: item.type,
              }],
            };

            // Always include destination if provided (even if empty string)
            if (item.destination !== undefined) {
              requestBody.destination = item.destination;
            }

            const response = await api.post('/api/upload/finalize', requestBody);

            if (!response.ok) {
              const data = await response.json().catch(() => ({}));
              throw new Error(data.error || `HTTP ${response.status}`);
            }

            const result = await response.json();
            const defaultPath = `${item.destination || 'inbox'}/${item.filename}`;
            const finalPath = result.path || result.paths?.[0] || defaultPath;
            const fileStatus = result.results?.[0]?.status;
            console.log('[UploadQueue] Upload finalized successfully:', {
              destination: item.destination,
              filename: item.filename,
              resultPath: result.path,
              finalPath,
              status: fileStatus ?? 'created',
              ...(fileStatus === 'skipped' ? { note: 'identical file already exists' } : {}),
            });

            resolve(finalPath);
          } catch (err) {
            reject(err);
          }
        },
        onAfterResponse: async (_req, _res) => {
          // Save TUS URL for resume
          if (upload.url && !item.tusUploadUrl) {
            const currentItem = await getItem(item.id);
            if (currentItem) {
              await saveItem({ ...currentItem, tusUploadUrl: upload.url });
            }
          }
        },
      });

      activeUpload.tusUpload = upload;

      // Start upload immediately without checking for previous uploads
      // We manage resume URLs ourselves via item.tusUploadUrl in IndexedDB
      // The TUS library's findPreviousUploads() uses browser fingerprinting which
      // causes stale resume attempts after the server has cleaned up completed uploads
      console.log('[UploadQueue] Starting upload');
      upload.start();

      // Set upload timeout
      const timeoutId = setTimeout(() => {
        upload.abort(true);
        reject(new Error('Upload timeout'));
      }, UPLOAD_TIMEOUT_MS);

      // Clear timeout on completion
      const originalOnSuccess = upload.options.onSuccess;
      const originalOnError = upload.options.onError;

      upload.options.onSuccess = (payload) => {
        clearTimeout(timeoutId);
        originalOnSuccess?.(payload);
      };

      upload.options.onError = (error) => {
        clearTimeout(timeoutId);
        originalOnError?.(error);
      };
    });
  }

  /**
   * Schedule retry for a failed item
   */
  private async scheduleRetry(item: PendingInboxItem, errorMessage: string): Promise<void> {
    const retryCount = item.retryCount + 1;
    const delayMs = getRetryDelay(retryCount);
    const nextRetryAt = Date.now() + delayMs;

    const updatedItem: PendingInboxItem = {
      ...item,
      status: 'uploading', // Keep as uploading so we retry
      retryCount,
      nextRetryAt,
      errorMessage,
      uploadingBy: undefined, // Release lock
      uploadingAt: undefined,
    };

    await saveItem(updatedItem);
    await this.notifyProgress();

    // Set timer to trigger retry
    const timer = setTimeout(() => {
      this.retryTimers.delete(item.id);
      this.processNext();
    }, delayMs);

    this.retryTimers.set(item.id, timer);

    console.log(`[UploadQueue] Scheduled retry #${retryCount} for ${item.id} in ${delayMs}ms`);
  }
}

// Singleton instance
let instance: UploadQueueManager | null = null;

/**
 * Get the singleton UploadQueueManager instance
 */
export function getUploadQueueManager(): UploadQueueManager {
  if (!instance) {
    instance = new UploadQueueManager();
  }
  return instance;
}
