/**
 * Upload Queue Manager
 *
 * Session-scoped queue for outbound uploads. The queue lives in memory on
 * the manager instance — close or reload the page and everything is gone.
 *
 * Responsibilities:
 * - TUS resumable uploads (within-session resume across chunk failures)
 * - Bounded concurrency (MAX_CONCURRENT_UPLOADS)
 * - Automatic retry with exponential backoff
 * - Wake on `online` event when the network comes back
 */

import * as tus from 'tus-js-client';
import { generateUUID } from '~/lib/uuid';
import type { PendingInboxItem } from './types';
import { QUEUE_CONSTANTS, RETRY_DELAYS_MS } from './types';
import { generateTextFilename, deduplicateFilename } from './filename';
import { api } from '~/lib/api';
import { parseApiError, formatApiError } from '~/lib/errors';

const {
  MAX_CONCURRENT_UPLOADS,
  SIMPLE_UPLOAD_THRESHOLD,
  UPLOAD_TIMEOUT_MS,
  RETRY_JITTER_PERCENT,
  MAX_RETRY_ATTEMPTS,
} = QUEUE_CONSTANTS;

type ProgressCallback = (items: PendingInboxItem[]) => void;
type UploadCompleteCallback = (item: PendingInboxItem, serverPath: string) => void;

interface ActiveUpload {
  itemId: string;
  abortController: AbortController;
  tusUpload?: tus.Upload;
}

function getRetryDelay(retryCount: number): number {
  const baseDelay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
  const jitter = baseDelay * RETRY_JITTER_PERCENT * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

/** Throttle interval for progress notifications (ms) */
const PROGRESS_THROTTLE_MS = 100;

export class UploadQueueManager {
  private items = new Map<string, PendingInboxItem>();
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

  async init(): Promise<void> {
    if (this.initialized) return;
    window.addEventListener('online', this.handleOnline);
    this.initialized = true;
  }

  private handleOnline = (): void => {
    console.log('[UploadQueue] Network online, kicking processor');
    this.processNext();
  };

  /**
   * Subscribe to progress updates
   */
  onProgress(callback: ProgressCallback): () => void {
    this.onProgressCallbacks.push(callback);
    return () => {
      const index = this.onProgressCallbacks.indexOf(callback);
      if (index >= 0) this.onProgressCallbacks.splice(index, 1);
    };
  }

  /**
   * Subscribe to upload complete events
   */
  onUploadComplete(callback: UploadCompleteCallback): () => void {
    this.onUploadCompleteCallbacks.push(callback);
    return () => {
      const index = this.onUploadCompleteCallbacks.indexOf(callback);
      if (index >= 0) this.onUploadCompleteCallbacks.splice(index, 1);
    };
  }

  private notifyProgress(): void {
    if (this.progressThrottleTimeout) {
      this.progressPending = true;
      return;
    }
    this.doNotifyProgress();
    this.progressThrottleTimeout = setTimeout(() => {
      this.progressThrottleTimeout = null;
      if (this.progressPending) {
        this.progressPending = false;
        this.doNotifyProgress();
      }
    }, PROGRESS_THROTTLE_MS);
  }

  private doNotifyProgress(): void {
    const items = Array.from(this.items.values());
    for (const callback of this.onProgressCallbacks) {
      try {
        callback(items);
      } catch (err) {
        console.error('[UploadQueue] Progress callback error:', err);
      }
    }
  }

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
   * Mutate an item in place by id; no-op if the item has been removed.
   */
  private patchItem(id: string, patch: Partial<PendingInboxItem>): PendingInboxItem | undefined {
    const current = this.items.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.items.set(id, next);
    return next;
  }

  /**
   * Enqueue text content for upload
   */
  async enqueueText(text: string, destination?: string): Promise<PendingInboxItem> {
    const id = generateUUID();
    const generatedName = generateTextFilename(text);
    const baseName = generatedName ?? id;
    const filename = `${baseName}.md`;
    const blob = new Blob([text], { type: 'text/markdown' });

    const item: PendingInboxItem = {
      id,
      createdAt: Date.now(),
      filename,
      blob,
      type: 'text/markdown',
      size: blob.size,
      status: 'saved',
      uploadProgress: 0,
      retryCount: 0,
      destination,
    };

    this.items.set(id, item);
    this.notifyProgress();
    this.processNext();
    return item;
  }

  /**
   * Enqueue a file for upload
   */
  async enqueueFile(file: File, usedNames?: Set<string>, destination?: string): Promise<PendingInboxItem> {
    const id = generateUUID();
    let filename = file.name;
    if (usedNames) {
      filename = deduplicateFilename(filename, usedNames);
      usedNames.add(filename);
    }

    const item: PendingInboxItem = {
      id,
      createdAt: Date.now(),
      filename,
      blob: file,
      type: file.type || 'application/octet-stream',
      size: file.size,
      status: 'saved',
      uploadProgress: 0,
      retryCount: 0,
      destination,
    };

    this.items.set(id, item);
    this.notifyProgress();
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

    if (text && text.trim()) {
      const textItem = await this.enqueueText(text.trim(), destination);
      items.push(textItem);
      usedNames.add(textItem.filename);
    }

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
      let filename = file.name;
      const key = `${destination}/${filename}`;
      if (usedNames.has(key)) {
        filename = deduplicateFilename(filename, usedNames);
      }
      usedNames.add(`${destination}/${filename}`);

      const item: PendingInboxItem = {
        id,
        createdAt: Date.now(),
        filename,
        blob: file,
        type: file.type || 'application/octet-stream',
        size: file.size,
        status: 'saved',
        uploadProgress: 0,
        retryCount: 0,
        destination,
      };

      this.items.set(id, item);
      items.push(item);
    }

    this.notifyProgress();
    this.processNext();
    return items;
  }

  /**
   * Get all pending items (for display)
   */
  async getPendingItems(): Promise<PendingInboxItem[]> {
    return Array.from(this.items.values());
  }

  /**
   * Cancel/delete an upload
   */
  async cancelUpload(id: string): Promise<void> {
    const active = this.activeUploads.get(id);
    if (active) {
      active.abortController.abort();
      if (active.tusUpload) active.tusUpload.abort(true);
      this.activeUploads.delete(id);
    }

    const timer = this.retryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }

    const item = this.items.get(id);
    if (item?.tusUploadUrl) {
      // Best-effort cleanup of TUS upload on the server. Extract path from URL
      // to avoid Mixed Content issues (http vs https).
      try {
        const url = new URL(item.tusUploadUrl);
        await api.delete(url.pathname);
      } catch {
        // ignore — server cleanup is best-effort
      }
    }

    this.items.delete(id);
    this.notifyProgress();
  }

  /**
   * Cancel every queued and in-flight upload. Terminal `failed` items are
   * left in place (the user explicitly dismisses those) and `uploaded`
   * items are obviously kept.
   */
  async cancelAllPending(): Promise<number> {
    const targets = Array.from(this.items.values()).filter(
      (item) => item.status === 'saved' || item.status === 'uploading',
    );
    await Promise.all(targets.map((item) => this.cancelUpload(item.id)));
    return targets.length;
  }

  /**
   * Manually retry a failed/stalled item.
   */
  async retryUpload(id: string): Promise<void> {
    const timer = this.retryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }

    const active = this.activeUploads.get(id);
    if (active) {
      active.abortController.abort();
      if (active.tusUpload) active.tusUpload.abort(true);
      this.activeUploads.delete(id);
    }

    if (!this.items.has(id)) return;

    this.patchItem(id, {
      status: 'saved',
      retryCount: 0,
      uploadProgress: 0,
      errorMessage: undefined,
      nextRetryAt: undefined,
    });
    this.notifyProgress();
    this.processNext();
  }

  /**
   * Delete completed uploads whose serverPath matches any of the given paths.
   * Called by file-tree when real files appear in the tree.
   */
  async deleteCompletedUploads(paths: Set<string>): Promise<void> {
    let deleted = 0;
    for (const item of Array.from(this.items.values())) {
      if (item.status === 'uploaded' && item.serverPath && paths.has(item.serverPath)) {
        this.items.delete(item.id);
        deleted++;
      }
    }
    if (deleted > 0) this.notifyProgress();
  }

  /**
   * Process next items from queue (fills up to MAX_CONCURRENT_UPLOADS).
   *
   * Uses a re-entry flag so concurrent calls coalesce — we never start the
   * same item twice.
   */
  async processNext(): Promise<void> {
    if (this.isProcessing) {
      this.needsReprocess = true;
      return;
    }

    this.isProcessing = true;
    try {
      do {
        this.needsReprocess = false;
        this.doProcessNext();
      } while (this.needsReprocess);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Pick the next ready item:
   * - status `saved`, or
   * - status `uploading` with a `nextRetryAt` that has fired (scheduled retry)
   *
   * Sorted by nextRetryAt (nulls first) then createdAt.
   */
  private pickNextReady(): PendingInboxItem | undefined {
    const now = Date.now();
    const ready: PendingInboxItem[] = [];
    for (const item of this.items.values()) {
      if (this.activeUploads.has(item.id)) continue;
      if (item.status === 'saved') {
        ready.push(item);
        continue;
      }
      if (item.status === 'uploading' && item.nextRetryAt && item.nextRetryAt <= now) {
        ready.push(item);
      }
    }
    ready.sort((a, b) => {
      if (a.nextRetryAt && b.nextRetryAt) return a.nextRetryAt - b.nextRetryAt;
      if (!a.nextRetryAt && b.nextRetryAt) return -1;
      if (a.nextRetryAt && !b.nextRetryAt) return 1;
      return a.createdAt - b.createdAt;
    });
    return ready[0];
  }

  private doProcessNext(): void {
    while (this.activeUploads.size < MAX_CONCURRENT_UPLOADS) {
      const item = this.pickNextReady();
      if (!item) break;

      this.activeUploads.set(item.id, {
        itemId: item.id,
        abortController: new AbortController(),
      });

      // Start upload asynchronously (don't await — we want concurrent uploads)
      this.uploadItem(item).catch((err) => {
        console.error('[UploadQueue] Unexpected error in uploadItem:', err);
      });
    }
  }

  /**
   * Upload a single item using TUS or simple PUT.
   */
  private async uploadItem(item: PendingInboxItem): Promise<void> {
    const activeUpload = this.activeUploads.get(item.id);
    if (!activeUpload) {
      console.error('[UploadQueue] Item not found in activeUploads (should not happen):', item.id);
      return;
    }

    try {
      const updatedItem = this.patchItem(item.id, {
        status: 'uploading',
        uploadProgress: item.tusUploadOffset ? Math.floor((item.tusUploadOffset / item.size) * 100) : 0,
        lastAttemptAt: Date.now(),
        errorMessage: undefined,
        nextRetryAt: undefined,
      });
      if (!updatedItem) return; // cancelled mid-flight
      this.notifyProgress();

      const serverPath = updatedItem.size <= SIMPLE_UPLOAD_THRESHOLD
        ? await this.performSimpleUpload(updatedItem, activeUpload)
        : await this.performTusUpload(updatedItem, activeUpload);

      const uploadedItem = this.patchItem(item.id, {
        status: 'uploaded',
        uploadProgress: 100,
        serverPath,
        uploadedAt: Date.now(),
      });
      if (uploadedItem) {
        this.notifyUploadComplete(uploadedItem, serverPath);
      }
      this.notifyProgress();
    } catch (err) {
      console.error('[UploadQueue] Upload failed:', err);
      if (activeUpload.abortController.signal.aborted) return;
      this.scheduleRetry(item, err instanceof Error ? err.message : 'Upload failed');
    } finally {
      this.activeUploads.delete(item.id);
      this.processNext();
    }
  }

  /**
   * Perform simple PUT upload for small files.
   * Single request: file body sent directly to server, which saves and registers it.
   */
  private async performSimpleUpload(
    item: PendingInboxItem,
    activeUpload: ActiveUpload
  ): Promise<string> {
    const destination = item.destination ?? 'inbox';
    const uploadPath = destination ? `${destination}/${item.filename}` : item.filename;
    const encodedPath = uploadPath.split('/').map(encodeURIComponent).join('/');

    const response = await api.fetch(`/api/data/uploads/simple/${encodedPath}`, {
      method: 'PUT',
      headers: { 'Content-Type': item.type || 'application/octet-stream' },
      body: item.blob,
      signal: activeUpload.abortController.signal,
    });

    if (!response.ok) {
      const apiErr = await parseApiError(response);
      throw new Error(formatApiError(apiErr));
    }

    const result = await response.json();
    const defaultPath = `${destination}/${item.filename}`;
    const finalPath = result.path || result.paths?.[0] || defaultPath;

    this.patchItem(item.id, { uploadProgress: 100, tusUploadOffset: item.size });
    this.notifyProgress();

    return finalPath;
  }

  /**
   * Perform TUS upload (for files larger than SIMPLE_UPLOAD_THRESHOLD).
   */
  private performTusUpload(
    item: PendingInboxItem,
    activeUpload: ActiveUpload
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const upload = new tus.Upload(item.blob, {
        endpoint: '/api/data/uploads/tus/',
        retryDelays: [], // we handle retries ourselves
        chunkSize: 10 * 1024 * 1024, // 10MB chunks
        uploadUrl: item.tusUploadUrl || undefined,
        metadata: {
          filename: item.filename,
          filetype: item.type,
        },
        headers: { 'Idempotency-Key': item.id },
        onError: (error) => {
          // If we get a 404 while trying to resume, the prior TUS URL is gone —
          // clear it so the next retry starts fresh.
          if (error.message && error.message.includes('404') && item.tusUploadUrl) {
            this.patchItem(item.id, { tusUploadUrl: undefined, tusUploadOffset: undefined });
          }
          reject(error);
        },
        onProgress: (bytesUploaded, bytesTotal) => {
          const percentage = Math.round((bytesUploaded / bytesTotal) * 100);
          this.patchItem(item.id, { uploadProgress: percentage, tusUploadOffset: bytesUploaded });
          this.notifyProgress();
        },
        onSuccess: async () => {
          try {
            const requestBody: Record<string, unknown> = {
              uploads: [{
                uploadId: upload.url?.split('/').pop(),
                filename: item.filename,
                size: item.size,
                type: item.type,
              }],
            };
            if (item.destination !== undefined) {
              requestBody.destination = item.destination;
            }

            const response = await api.post('/api/data/uploads/finalize', requestBody);
            if (!response.ok) {
              const apiErr = await parseApiError(response);
              throw new Error(formatApiError(apiErr));
            }

            const result = await response.json();
            const defaultPath = `${item.destination || 'inbox'}/${item.filename}`;
            const finalPath = result.path || result.paths?.[0] || defaultPath;
            resolve(finalPath);
          } catch (err) {
            reject(err);
          }
        },
        onAfterResponse: (_req, _res) => {
          if (upload.url && !item.tusUploadUrl) {
            this.patchItem(item.id, { tusUploadUrl: upload.url });
          }
        },
      });

      activeUpload.tusUpload = upload;
      upload.start();

      const timeoutId = setTimeout(() => {
        upload.abort(true);
        reject(new Error('Upload timeout'));
      }, UPLOAD_TIMEOUT_MS);

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
   * Schedule retry for a failed item — or mark it terminally `failed` if the
   * retry budget is exhausted.
   */
  private scheduleRetry(item: PendingInboxItem, errorMessage: string): void {
    const retryCount = item.retryCount + 1;

    if (retryCount >= MAX_RETRY_ATTEMPTS) {
      this.patchItem(item.id, {
        status: 'failed',
        errorMessage,
        nextRetryAt: undefined,
      });
      this.notifyProgress();
      console.log(
        `[UploadQueue] Item ${item.id} failed terminally after ${retryCount} attempts: ${errorMessage}`
      );
      return;
    }

    const delayMs = getRetryDelay(retryCount);
    const nextRetryAt = Date.now() + delayMs;

    this.patchItem(item.id, {
      status: 'uploading',
      retryCount,
      nextRetryAt,
      errorMessage,
    });
    this.notifyProgress();

    const timer = setTimeout(() => {
      this.retryTimers.delete(item.id);
      this.processNext();
    }, delayMs);
    this.retryTimers.set(item.id, timer);
  }
}

// Singleton instance
let instance: UploadQueueManager | null = null;

export function getUploadQueueManager(): UploadQueueManager {
  if (!instance) {
    instance = new UploadQueueManager();
  }
  return instance;
}
