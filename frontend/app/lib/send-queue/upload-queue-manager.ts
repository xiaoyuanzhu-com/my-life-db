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
  getNextItemToProcess,
  acquireLock,
  updateHeartbeat,
  updateProgress,
  markUploaded,
  requestPersistentStorage,
} from './db';
import { generateTextFilename, deduplicateFilename } from './filename';

const {
  MAX_CONCURRENT_UPLOADS,
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
  return crypto.randomUUID();
}

/**
 * Calculate retry delay with jitter
 */
function getRetryDelay(retryCount: number): number {
  const baseDelay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
  const jitter = baseDelay * RETRY_JITTER_PERCENT * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

export class UploadQueueManager {
  private tabId: string;
  private activeUploads = new Map<string, ActiveUpload>();
  private isProcessing = false;
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private onProgressCallbacks: ProgressCallback[] = [];
  private onUploadCompleteCallbacks: UploadCompleteCallback[] = [];
  private initialized = false;

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
   * Notify progress subscribers
   */
  private async notifyProgress(): Promise<void> {
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
  async enqueueText(text: string): Promise<PendingInboxItem> {
    const id = generateUUID();
    const now = new Date().toISOString();

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
  async enqueueFile(file: File, usedNames?: Set<string>): Promise<PendingInboxItem> {
    const id = generateUUID();
    const now = new Date().toISOString();

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
    files: File[]
  ): Promise<PendingInboxItem[]> {
    const items: PendingInboxItem[] = [];
    const usedNames = new Set<string>();

    // Enqueue text first (if provided)
    if (text && text.trim()) {
      const textItem = await this.enqueueText(text.trim());
      items.push(textItem);
      usedNames.add(textItem.filename);
    }

    // Enqueue files
    for (const file of files) {
      const fileItem = await this.enqueueFile(file, usedNames);
      items.push(fileItem);
    }

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
        await fetch(url.pathname, { method: 'DELETE' });
      } catch {
        // Ignore errors - server cleanup is best-effort
      }
    }

    // Delete from IndexedDB
    await deleteItem(id);
    await this.notifyProgress();
  }

  /**
   * Process the next item in the queue
   */
  async processNext(): Promise<void> {
    // Don't start if we're at max concurrent uploads
    if (this.activeUploads.size >= MAX_CONCURRENT_UPLOADS) {
      return;
    }

    // Get next item to process
    const item = await getNextItemToProcess(this.tabId);
    if (!item) {
      return;
    }

    // Skip if already being processed
    if (this.activeUploads.has(item.id)) {
      return;
    }

    // Try to acquire lock
    const locked = await acquireLock(item.id, this.tabId);
    if (!locked) {
      // Another tab got it, try next
      this.processNext();
      return;
    }

    // Start upload
    this.uploadItem(item);

    // Try to process more items (up to max concurrent)
    if (this.activeUploads.size < MAX_CONCURRENT_UPLOADS) {
      this.processNext();
    }
  }

  /**
   * Upload a single item using TUS
   */
  private async uploadItem(item: PendingInboxItem): Promise<void> {
    const abortController = new AbortController();
    const activeUpload: ActiveUpload = {
      itemId: item.id,
      abortController,
    };

    this.activeUploads.set(item.id, activeUpload);

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
        lastAttemptAt: new Date().toISOString(),
        errorMessage: undefined,
        nextRetryAt: undefined,
      };
      await saveItem(updatedItem);
      await this.notifyProgress();

      // Create TUS upload
      const serverPath = await this.performTusUpload(updatedItem, activeUpload);

      // Success! Mark as uploaded
      await markUploaded(item.id, serverPath);
      this.notifyUploadComplete(updatedItem, serverPath);
      await this.notifyProgress();

    } catch (err) {
      console.error('[UploadQueue] Upload failed:', err);

      // Check if aborted
      if (abortController.signal.aborted) {
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
   * Perform TUS upload
   */
  private performTusUpload(
    item: PendingInboxItem,
    activeUpload: ActiveUpload
  ): Promise<string> {
    return new Promise((resolve, reject) => {
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
        onError: (error) => {
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
            const response = await fetch('/api/upload/finalize', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                uploads: [{
                  uploadId: upload.url?.split('/').pop(),
                  filename: item.filename,
                  size: item.size,
                  type: item.type,
                }],
              }),
            });

            if (!response.ok) {
              const data = await response.json().catch(() => ({}));
              throw new Error(data.error || `HTTP ${response.status}`);
            }

            const result = await response.json();
            resolve(result.path || result.paths?.[0] || `inbox/${item.filename}`);
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

      // Check for previous uploads to resume
      upload.findPreviousUploads().then((previousUploads) => {
        if (previousUploads.length > 0) {
          upload.resumeFromPreviousUpload(previousUploads[0]);
        }
        upload.start();
      });

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
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

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
