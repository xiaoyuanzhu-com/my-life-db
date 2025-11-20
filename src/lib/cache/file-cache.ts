import { openDB, DBSchema, IDBPDatabase } from 'idb';

/**
 * IndexedDB-based file cache with LRU eviction
 * Provides persistent, offline-capable file storage
 */

interface CachedFile {
  path: string;
  blob: Blob;
  contentType: string;
  size: number;
  lastAccessed: number;
  accessCount: number;
  cachedAt: number;
}

interface FileCacheDB extends DBSchema {
  files: {
    key: string;
    value: CachedFile;
    indexes: {
      'by-lastAccessed': number;
      'by-size': number;
    };
  };
  metadata: {
    key: string;
    value: {
      totalSize: number;
      lastCleanup: number;
    };
  };
}

const DB_NAME = 'mylifedb-file-cache';
const DB_VERSION = 1;
const STORE_NAME = 'files';
const METADATA_STORE = 'metadata';

// Cache limits
const MAX_CACHE_SIZE = 500 * 1024 * 1024; // 500MB
const TARGET_SIZE_AFTER_CLEANUP = MAX_CACHE_SIZE * 0.7; // 70% of max
const CLEANUP_CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes

class FileCache {
  private db: IDBPDatabase<FileCacheDB> | null = null;
  private initPromise: Promise<void> | null = null;
  private lastCleanupCheck = 0;

  /**
   * Initialize the IndexedDB database
   */
  private async init(): Promise<void> {
    if (this.db) return;

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      this.db = await openDB<FileCacheDB>(DB_NAME, DB_VERSION, {
        upgrade(db) {
          // Create files store
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'path' });
            store.createIndex('by-lastAccessed', 'lastAccessed');
            store.createIndex('by-size', 'size');
          }

          // Create metadata store
          if (!db.objectStoreNames.contains(METADATA_STORE)) {
            db.createObjectStore(METADATA_STORE);
          }
        },
      });

      // Initialize metadata if not exists
      const metadata = await this.db.get(METADATA_STORE, 'stats');
      if (!metadata) {
        await this.db.put(METADATA_STORE, {
          totalSize: 0,
          lastCleanup: Date.now(),
        }, 'stats');
      }
    })();

    await this.initPromise;
  }

  /**
   * Get a file from cache
   */
  async get(path: string): Promise<{ blob: Blob; contentType: string } | null> {
    await this.init();
    if (!this.db) return null;

    try {
      const cached = await this.db.get(STORE_NAME, path);
      if (!cached) return null;

      // Update access metadata
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      await tx.store.put({
        ...cached,
        lastAccessed: Date.now(),
        accessCount: cached.accessCount + 1,
      });
      await tx.done;

      return {
        blob: cached.blob,
        contentType: cached.contentType,
      };
    } catch (error) {
      console.error('Failed to get file from cache:', error);
      return null;
    }
  }

  /**
   * Put a file into cache
   */
  async put(path: string, blob: Blob, contentType: string): Promise<void> {
    await this.init();
    if (!this.db) return;

    try {
      const now = Date.now();
      const size = blob.size;

      // Check if we need cleanup
      await this.checkAndCleanup(size);

      // Get existing file if any
      const existing = await this.db.get(STORE_NAME, path);
      const oldSize = existing?.size || 0;

      // Store the file
      const cachedFile: CachedFile = {
        path,
        blob,
        contentType,
        size,
        lastAccessed: now,
        accessCount: existing ? existing.accessCount + 1 : 1,
        cachedAt: existing?.cachedAt || now,
      };

      await this.db.put(STORE_NAME, cachedFile);

      // Update total size
      const metadata = await this.db.get(METADATA_STORE, 'stats');
      if (metadata) {
        await this.db.put(METADATA_STORE, {
          ...metadata,
          totalSize: metadata.totalSize - oldSize + size,
        }, 'stats');
      }
    } catch (error) {
      console.error('Failed to put file into cache:', error);
    }
  }

  /**
   * Check if cleanup is needed and perform LRU eviction
   */
  private async checkAndCleanup(newFileSize: number = 0): Promise<void> {
    if (!this.db) return;

    const now = Date.now();
    if (now - this.lastCleanupCheck < CLEANUP_CHECK_INTERVAL) {
      return;
    }

    this.lastCleanupCheck = now;

    try {
      const metadata = await this.db.get(METADATA_STORE, 'stats');
      if (!metadata) return;

      const projectedSize = metadata.totalSize + newFileSize;

      // Only cleanup if we exceed the limit
      if (projectedSize <= MAX_CACHE_SIZE) return;

      console.log(`[FileCache] Cache size ${(projectedSize / 1024 / 1024).toFixed(2)}MB exceeds limit, performing LRU cleanup...`);

      // Get all files sorted by last accessed (LRU)
      const allFiles = await this.db.getAllFromIndex(STORE_NAME, 'by-lastAccessed');

      let totalSize = metadata.totalSize;
      const filesToDelete: string[] = [];

      // Delete oldest accessed files until we reach target size
      for (const file of allFiles) {
        if (totalSize <= TARGET_SIZE_AFTER_CLEANUP) break;

        filesToDelete.push(file.path);
        totalSize -= file.size;
      }

      // Perform deletion
      if (filesToDelete.length > 0) {
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        for (const path of filesToDelete) {
          await tx.store.delete(path);
        }
        await tx.done;

        // Update metadata
        await this.db.put(METADATA_STORE, {
          totalSize,
          lastCleanup: now,
        }, 'stats');

        console.log(`[FileCache] Evicted ${filesToDelete.length} files, new size: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);
      }
    } catch (error) {
      console.error('Failed to cleanup cache:', error);
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{ totalSize: number; fileCount: number; lastCleanup: number } | null> {
    await this.init();
    if (!this.db) return null;

    try {
      const metadata = await this.db.get(METADATA_STORE, 'stats');
      const fileCount = await this.db.count(STORE_NAME);

      return {
        totalSize: metadata?.totalSize || 0,
        fileCount,
        lastCleanup: metadata?.lastCleanup || 0,
      };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return null;
    }
  }

  /**
   * Clear all cached files
   */
  async clear(): Promise<void> {
    await this.init();
    if (!this.db) return;

    try {
      await this.db.clear(STORE_NAME);
      await this.db.put(METADATA_STORE, {
        totalSize: 0,
        lastCleanup: Date.now(),
      }, 'stats');

      console.log('[FileCache] Cache cleared');
    } catch (error) {
      console.error('Failed to clear cache:', error);
    }
  }

  /**
   * Remove a specific file from cache
   */
  async remove(path: string): Promise<void> {
    await this.init();
    if (!this.db) return;

    try {
      const cached = await this.db.get(STORE_NAME, path);
      if (!cached) return;

      await this.db.delete(STORE_NAME, path);

      // Update total size
      const metadata = await this.db.get(METADATA_STORE, 'stats');
      if (metadata) {
        await this.db.put(METADATA_STORE, {
          ...metadata,
          totalSize: Math.max(0, metadata.totalSize - cached.size),
        }, 'stats');
      }
    } catch (error) {
      console.error('Failed to remove file from cache:', error);
    }
  }
}

// Singleton instance
export const fileCache = new FileCache();
