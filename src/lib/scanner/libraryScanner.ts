import 'server-only';
// Periodic scanner for library folders
// Scans DATA_ROOT for folders and files, creates/updates items in database
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { DATA_ROOT, generateId } from '@/lib/fs/storage';
import { createItem, getItemByPath, updateItem } from '@/lib/db/items';
import type { Item, ItemFile, MessageType } from '@/types';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'LibraryScanner' });

// Reserved folder names that should not be indexed
const RESERVED_FOLDERS = ['inbox', 'app', '.app', '.git', '.mylifedb', 'node_modules'];

// Hash files smaller than 10MB
const HASH_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10MB

interface ScanStats {
  scanned: number;
  created: number;
  updated: number;
  errors: number;
}

/**
 * Scan the library (all folders except reserved ones)
 * @param force If true, rescan all files even if they haven't changed
 */
export async function scanLibrary(force: boolean = false): Promise<ScanStats> {
  const stats: ScanStats = {
    scanned: 0,
    created: 0,
    updated: 0,
    errors: 0,
  };

  log.info({ force }, 'starting library scan');

  try {
    // Get all top-level items in DATA_ROOT
    const items = await fs.readdir(DATA_ROOT, { withFileTypes: true });

    for (const item of items) {
      // Skip reserved folders
      if (RESERVED_FOLDERS.includes(item.name)) {
        continue;
      }

      // Skip hidden files/folders (except already indexed ones)
      if (item.name.startsWith('.')) {
        continue;
      }

      const itemPath = path.join(DATA_ROOT, item.name);
      const relativePath = item.name;

      try {
        if (item.isDirectory()) {
          await scanDirectory(relativePath, itemPath, stats, force);
        } else if (item.isFile()) {
          await scanFile(relativePath, itemPath, stats, force);
        }
      } catch (error) {
        log.error({ err: error, path: relativePath }, 'failed to scan item');
        stats.errors++;
      }
    }

    log.info(stats, 'library scan completed');
  } catch (error) {
    log.error({ err: error }, 'library scan failed');
  }

  return stats;
}

/**
 * Scan a directory (recursively)
 */
async function scanDirectory(
  relativePath: string,
  fullPath: string,
  stats: ScanStats,
  force: boolean
): Promise<void> {
  stats.scanned++;

  // Get directory contents
  const items = await fs.readdir(fullPath, { withFileTypes: true });
  const files: ItemFile[] = [];

  // Process files in directory
  for (const item of items) {
    // Skip hidden files
    if (item.name.startsWith('.')) {
      continue;
    }

    if (item.isFile()) {
      const fileStats = await fs.stat(path.join(fullPath, item.name));
      const mimeType = getMimeType(item.name);

      // Hash small files
      let hash: string | undefined;
      if (fileStats.size < HASH_SIZE_THRESHOLD) {
        const buffer = await fs.readFile(path.join(fullPath, item.name));
        hash = createHash('sha256').update(buffer).digest('hex');
      }

      files.push({
        name: item.name,
        size: fileStats.size,
        type: mimeType,
        hash,
        modifiedAt: fileStats.mtime.toISOString(),
      });
    }
  }

  // Check if item exists in database
  const existing = getItemByPath(relativePath);
  const now = new Date().toISOString();

  if (!existing) {
    // Create new item
    const item: Item = {
      id: generateId(),
      name: path.basename(relativePath),
      rawType: 'mixed', // Folders are always mixed
      detectedType: null,
      isFolder: true,
      path: relativePath,
      files: files.length > 0 ? files : null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };

    createItem(item);
    stats.created++;
    log.debug({ path: relativePath, fileCount: files.length }, 'created folder item');
  } else if (force || hasFilesChanged(existing.files, files)) {
    // Update existing item
    updateItem(existing.id, {
      files: files.length > 0 ? files : null,
      updatedAt: now,
    });
    stats.updated++;
    log.debug({ path: relativePath }, 'updated folder item');
  }

  // Recursively scan subdirectories
  for (const item of items) {
    if (item.isDirectory() && !item.name.startsWith('.')) {
      const subPath = path.join(relativePath, item.name);
      const subFullPath = path.join(fullPath, item.name);
      await scanDirectory(subPath, subFullPath, stats, force);
    }
  }
}

/**
 * Scan a single file
 */
async function scanFile(
  relativePath: string,
  fullPath: string,
  stats: ScanStats,
  force: boolean
): Promise<void> {
  stats.scanned++;

  const fileStats = await fs.stat(fullPath);
  const filename = path.basename(relativePath);
  const mimeType = getMimeType(filename);
  const rawType = getRawTypeFromMime(mimeType);

  // Hash small files
  let hash: string | undefined;
  if (fileStats.size < HASH_SIZE_THRESHOLD) {
    const buffer = await fs.readFile(fullPath);
    hash = createHash('sha256').update(buffer).digest('hex');
  }

  const itemFile: ItemFile = {
    name: filename,
    size: fileStats.size,
    type: mimeType,
    hash,
    modifiedAt: fileStats.mtime.toISOString(),
  };

  // Check if item exists
  const existing = getItemByPath(relativePath);
  const now = new Date().toISOString();

  if (!existing) {
    // Create new item
    const item: Item = {
      id: generateId(),
      name: filename,
      rawType,
      detectedType: null,
      isFolder: false,
      path: relativePath,
      files: [itemFile],
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };

    createItem(item);
    stats.created++;
    log.debug({ path: relativePath, size: fileStats.size }, 'created file item');
  } else if (force || hasFileChanged(existing.files?.[0], itemFile)) {
    // Update existing item
    updateItem(existing.id, {
      files: [itemFile],
      updatedAt: now,
    });
    stats.updated++;
    log.debug({ path: relativePath }, 'updated file item');
  }
}

/**
 * Check if files list has changed
 */
function hasFilesChanged(oldFiles: ItemFile[] | null, newFiles: ItemFile[]): boolean {
  if (!oldFiles) return true;
  if (oldFiles.length !== newFiles.length) return true;

  // Check if any file has different hash or size
  const oldMap = new Map(oldFiles.map(f => [f.name, f]));

  for (const newFile of newFiles) {
    const oldFile = oldMap.get(newFile.name);
    if (!oldFile) return true;

    // Compare hash if available, otherwise compare size
    if (newFile.hash && oldFile.hash) {
      if (newFile.hash !== oldFile.hash) return true;
    } else if (newFile.size !== oldFile.size) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a single file has changed
 */
function hasFileChanged(oldFile: ItemFile | undefined, newFile: ItemFile): boolean {
  if (!oldFile) return true;

  // Compare hash if available
  if (newFile.hash && oldFile.hash) {
    return newFile.hash !== oldFile.hash;
  }

  // Compare size
  return newFile.size !== oldFile.size;
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

/**
 * Get raw type from MIME type
 */
function getRawTypeFromMime(mimeType: string): MessageType {
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'mixed';
}

/**
 * Start periodic scanner
 * Scans library every hour
 */
export function startPeriodicScanner(): NodeJS.Timeout {
  const SCAN_INTERVAL = 60 * 60 * 1000; // 1 hour

  log.info({ intervalMinutes: 60 }, 'starting periodic library scanner');

  // Initial scan after 10 seconds (give app time to start)
  setTimeout(() => {
    scanLibrary(false).catch(err => {
      log.error({ err }, 'initial library scan failed');
    });
  }, 10000);

  // Periodic scan
  const timer = setInterval(() => {
    scanLibrary(false).catch(err => {
      log.error({ err }, 'periodic library scan failed');
    });
  }, SCAN_INTERVAL);

  return timer;
}
