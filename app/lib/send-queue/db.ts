/**
 * IndexedDB operations for the send queue
 */

import type { PendingInboxItem } from './types';
import { QUEUE_CONSTANTS } from './types';

const { DB_NAME, STORE_NAME, DB_VERSION, LOCK_STALE_THRESHOLD_MS } = QUEUE_CONSTANTS;

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Open the IndexedDB database
 */
export function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      dbPromise = null;
      reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });

        // Index for querying items to process
        // Composite index: status + nextRetryAt for efficient queries
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('nextRetryAt', 'nextRetryAt', { unique: false });
      }
    };
  });

  return dbPromise;
}

/**
 * Save a pending item to IndexedDB
 */
export async function saveItem(item: PendingInboxItem): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(item);

    request.onerror = () => reject(new Error(`Failed to save item: ${request.error?.message}`));
    request.onsuccess = () => resolve();
  });
}

/**
 * Get a pending item by ID
 */
export async function getItem(id: string): Promise<PendingInboxItem | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onerror = () => reject(new Error(`Failed to get item: ${request.error?.message}`));
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Delete a pending item by ID
 */
export async function deleteItem(id: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onerror = () => reject(new Error(`Failed to delete item: ${request.error?.message}`));
    request.onsuccess = () => resolve();
  });
}

/**
 * Get all pending items (for feed display)
 */
export async function getAllItems(): Promise<PendingInboxItem[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onerror = () => reject(new Error(`Failed to get all items: ${request.error?.message}`));
    request.onsuccess = () => resolve(request.result || []);
  });
}

/**
 * Get the next item to process
 * Query: status = 'saved' OR (status = 'uploading' AND lock is stale AND nextRetryAt <= now)
 * Order by: nextRetryAt ASC NULLS FIRST, createdAt ASC
 */
export async function getNextItemToProcess(tabId: string): Promise<PendingInboxItem | undefined> {
  const db = await openDatabase();
  const now = new Date().toISOString();
  const staleThreshold = Date.now() - LOCK_STALE_THRESHOLD_MS;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onerror = () => reject(new Error(`Failed to query items: ${request.error?.message}`));
    request.onsuccess = () => {
      const items: PendingInboxItem[] = request.result || [];

      // Filter items that are ready to process
      const ready = items.filter((item) => {
        // Uploaded items are done
        if (item.status === 'uploaded') return false;

        // Saved items are always ready
        if (item.status === 'saved') return true;

        // Uploading items - check if we should take over
        if (item.status === 'uploading') {
          // Already being uploaded by this tab
          if (item.uploadingBy === tabId) return true;

          // Check if lock is stale
          if (item.uploadingAt) {
            const lockTime = new Date(item.uploadingAt).getTime();
            if (lockTime < staleThreshold) {
              // Lock is stale, we can take over
              // Also check nextRetryAt
              if (!item.nextRetryAt || item.nextRetryAt <= now) {
                return true;
              }
            }
          }

          // Check if retry is due (for failed uploads)
          if (item.nextRetryAt && item.nextRetryAt <= now) {
            // Check if lock is stale or doesn't exist
            if (!item.uploadingAt || new Date(item.uploadingAt).getTime() < staleThreshold) {
              return true;
            }
          }
        }

        return false;
      });

      // Sort by nextRetryAt ASC (nulls first), then createdAt ASC
      ready.sort((a, b) => {
        // Both have nextRetryAt
        if (a.nextRetryAt && b.nextRetryAt) {
          return a.nextRetryAt.localeCompare(b.nextRetryAt);
        }
        // a has no nextRetryAt (goes first)
        if (!a.nextRetryAt && b.nextRetryAt) return -1;
        // b has no nextRetryAt (goes first)
        if (a.nextRetryAt && !b.nextRetryAt) return 1;
        // Neither has nextRetryAt - sort by createdAt
        return a.createdAt.localeCompare(b.createdAt);
      });

      resolve(ready[0]);
    };
  });
}

/**
 * Acquire lock on an item for uploading
 * Returns true if lock was acquired, false if another tab got it
 */
export async function acquireLock(id: string, tabId: string): Promise<boolean> {
  const db = await openDatabase();
  const now = new Date().toISOString();
  const staleThreshold = Date.now() - LOCK_STALE_THRESHOLD_MS;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    // Get the current state
    const getRequest = store.get(id);

    getRequest.onerror = () => reject(new Error(`Failed to get item for lock: ${getRequest.error?.message}`));
    getRequest.onsuccess = () => {
      const item: PendingInboxItem | undefined = getRequest.result;
      if (!item) {
        resolve(false);
        return;
      }

      // Check if locked by another tab with a fresh lock
      if (item.uploadingBy && item.uploadingBy !== tabId && item.uploadingAt) {
        const lockTime = new Date(item.uploadingAt).getTime();
        if (lockTime >= staleThreshold) {
          // Lock is fresh, cannot acquire
          resolve(false);
          return;
        }
      }

      // Acquire the lock
      const updatedItem: PendingInboxItem = {
        ...item,
        status: 'uploading',
        uploadingBy: tabId,
        uploadingAt: now,
      };

      const putRequest = store.put(updatedItem);
      putRequest.onerror = () => reject(new Error(`Failed to acquire lock: ${putRequest.error?.message}`));
      putRequest.onsuccess = () => resolve(true);
    };
  });
}

/**
 * Update lock heartbeat
 */
export async function updateHeartbeat(id: string, tabId: string): Promise<void> {
  const db = await openDatabase();
  const now = new Date().toISOString();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const getRequest = store.get(id);
    getRequest.onerror = () => reject(new Error(`Failed to get item for heartbeat: ${getRequest.error?.message}`));
    getRequest.onsuccess = () => {
      const item: PendingInboxItem | undefined = getRequest.result;
      if (!item || item.uploadingBy !== tabId) {
        resolve();
        return;
      }

      const updatedItem: PendingInboxItem = {
        ...item,
        uploadingAt: now,
      };

      const putRequest = store.put(updatedItem);
      putRequest.onerror = () => reject(new Error(`Failed to update heartbeat: ${putRequest.error?.message}`));
      putRequest.onsuccess = () => resolve();
    };
  });
}

/**
 * Update item progress
 */
export async function updateProgress(
  id: string,
  progress: number,
  tusOffset?: number
): Promise<void> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const getRequest = store.get(id);
    getRequest.onerror = () => reject(new Error(`Failed to get item for progress: ${getRequest.error?.message}`));
    getRequest.onsuccess = () => {
      const item: PendingInboxItem | undefined = getRequest.result;
      if (!item) {
        resolve();
        return;
      }

      const updatedItem: PendingInboxItem = {
        ...item,
        uploadProgress: progress,
        ...(tusOffset !== undefined && { tusUploadOffset: tusOffset }),
      };

      const putRequest = store.put(updatedItem);
      putRequest.onerror = () => reject(new Error(`Failed to update progress: ${putRequest.error?.message}`));
      putRequest.onsuccess = () => resolve();
    };
  });
}

/**
 * Mark item as uploaded and delete from queue
 */
export async function markUploaded(id: string, _serverPath: string): Promise<void> {
  // Simply delete the item - it's now on the server
  await deleteItem(id);
}

/**
 * Request persistent storage to prevent browser eviction
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (navigator.storage && navigator.storage.persist) {
    return navigator.storage.persist();
  }
  return false;
}

/**
 * Check if we have persistent storage
 */
export async function hasPersistentStorage(): Promise<boolean> {
  if (navigator.storage && navigator.storage.persisted) {
    return navigator.storage.persisted();
  }
  return false;
}
