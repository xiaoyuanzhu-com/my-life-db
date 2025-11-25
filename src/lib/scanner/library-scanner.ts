import 'server-only';
// Periodic scanner for library folders
// Scans DATA_ROOT for folders and files, updates files table cache
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { DATA_ROOT } from '@/lib/fs/storage';
import { upsertFileRecord, getFileByPath, getAllFilePaths } from '@/lib/db/files';
import { deleteFile } from '@/lib/files/delete-file';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'LibraryScanner' });

// Reserved folder names that should not be indexed
const RESERVED_FOLDERS = ['app', '.app', '.git', '.mylifedb', 'node_modules'];

// Hash files smaller than 10MB
const HASH_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10MB

interface ScanStats {
  scanned: number;
  created: number;
  updated: number;
  orphansDeleted: number;
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
    orphansDeleted: 0,
    errors: 0,
  };

  log.info({ force }, 'starting library scan');

  // Track all scanned paths (to detect orphans later)
  const scannedPaths = new Set<string>();

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
          await scanDirectory(relativePath, itemPath, stats, force, scannedPaths);
        } else if (item.isFile()) {
          await scanFile(relativePath, itemPath, stats, force);
          scannedPaths.add(relativePath);
        }
      } catch (error) {
        log.error({ err: error, path: relativePath }, 'failed to scan item');
        stats.errors++;
      }
    }

    // Always cleanup orphans - filesystem is the source of truth
    await cleanupOrphans(scannedPaths, stats);

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
  force: boolean,
  scannedPaths: Set<string>
): Promise<void> {
  stats.scanned++;
  scannedPaths.add(relativePath);

  // Get directory stats
  const dirStats = await fs.stat(fullPath);

  // Upsert folder record in files table
  const existing = getFileByPath(relativePath);
  if (!existing) {
    upsertFileRecord({
      path: relativePath,
      name: path.basename(relativePath),
      isFolder: true,
      modifiedAt: dirStats.mtime.toISOString(),
    });
    stats.created++;
    log.debug({ path: relativePath }, 'indexed folder');
  } else if (force) {
    upsertFileRecord({
      path: relativePath,
      name: path.basename(relativePath),
      isFolder: true,
      modifiedAt: dirStats.mtime.toISOString(),
    });
    stats.updated++;
  }

  // Get directory contents
  const items = await fs.readdir(fullPath, { withFileTypes: true });

  // Process each item
  for (const item of items) {
    // Skip hidden files
    if (item.name.startsWith('.')) {
      continue;
    }

    if (item.isDirectory()) {
      const subPath = path.join(relativePath, item.name);
      const subFullPath = path.join(fullPath, item.name);
      await scanDirectory(subPath, subFullPath, stats, force, scannedPaths);
    } else if (item.isFile()) {
      const filePath = path.join(relativePath, item.name);
      const fileFullPath = path.join(fullPath, item.name);
      await scanFile(filePath, fileFullPath, stats, force);
      scannedPaths.add(filePath);
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

  // Hash small files
  let hash: string | undefined;
  if (fileStats.size < HASH_SIZE_THRESHOLD) {
    const buffer = await fs.readFile(fullPath);
    hash = createHash('sha256').update(buffer).digest('hex');
  }

  // Read text preview for text files (first 50 lines)
  let textPreview: string | undefined;
  if (mimeType?.startsWith('text/')) {
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n').slice(0, 50);
      textPreview = lines.join('\n');
    } catch {
      // Ignore errors reading text preview
    }
  }

  // Check if file exists in database
  const existing = getFileByPath(relativePath);

  // Determine if we need to update
  const shouldUpdate = force || !existing || hasFileChanged(existing, {
    size: fileStats.size,
    hash,
    modifiedAt: fileStats.mtime.toISOString(),
  });

  if (shouldUpdate) {
    upsertFileRecord({
      path: relativePath,
      name: filename,
      isFolder: false,
      size: fileStats.size,
      mimeType,
      hash,
      modifiedAt: fileStats.mtime.toISOString(),
      textPreview,
    });

    if (!existing) {
      stats.created++;
      log.debug({ path: relativePath, size: fileStats.size }, 'indexed file');
    } else {
      stats.updated++;
      log.debug({ path: relativePath }, 'updated file');
    }
  }
}

/**
 * Check if a file has changed
 */
function hasFileChanged(
  existingFile: { size?: number | null; hash?: string | null; modifiedAt?: string },
  newFile: { size: number; hash?: string; modifiedAt: string }
): boolean {
  // Compare hash if available
  if (newFile.hash && existingFile.hash) {
    return newFile.hash !== existingFile.hash;
  }

  // Compare size
  if (existingFile.size !== null && existingFile.size !== undefined) {
    if (newFile.size !== existingFile.size) return true;
  }

  // Compare modification time as fallback
  if (existingFile.modifiedAt) {
    return newFile.modifiedAt !== existingFile.modifiedAt;
  }

  return false;
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
 * Global scanner timer (for cleanup)
 */
let scannerTimer: NodeJS.Timeout | null = null;
let initialScanTimer: NodeJS.Timeout | null = null;

/**
 * Start periodic scanner
 * Scans library every hour
 */
export function startPeriodicScanner(): NodeJS.Timeout {
  const SCAN_INTERVAL = 60 * 60 * 1000; // 1 hour

  // Prevent multiple scanners from running
  if (scannerTimer) {
    log.warn({}, 'periodic scanner already running, skipping');
    return scannerTimer;
  }

  log.info({ intervalMinutes: 60 }, 'starting periodic library scanner');

  // Initial scan after 10 seconds (give app time to start)
  initialScanTimer = setTimeout(() => {
    initialScanTimer = null;
    scanLibrary(false).catch(err => {
      log.error({ err }, 'initial library scan failed');
    });
  }, 10000);

  // Periodic scan
  scannerTimer = setInterval(() => {
    scanLibrary(false).catch(err => {
      log.error({ err }, 'periodic library scan failed');
    });
  }, SCAN_INTERVAL);

  return scannerTimer;
}

/**
 * Stop periodic scanner and cleanup timers
 */
export function stopPeriodicScanner(): void {
  if (scannerTimer) {
    clearInterval(scannerTimer);
    scannerTimer = null;
    log.debug({}, 'periodic scanner stopped');
  }

  if (initialScanTimer) {
    clearTimeout(initialScanTimer);
    initialScanTimer = null;
  }
}

/**
 * Detect and clean up orphaned database records
 * Compares scanned paths against database records and deletes orphans
 * Filesystem is the source of truth - always trust the scan results
 */
async function cleanupOrphans(scannedPaths: Set<string>, stats: ScanStats): Promise<void> {
  try {
    // Get all file paths from database (excluding reserved folders)
    const dbPaths = getAllFilePaths(RESERVED_FOLDERS);

    log.debug({ dbCount: dbPaths.length, scannedCount: scannedPaths.size }, 'checking for orphans');

    // Find orphans: files in DB but not on filesystem
    const orphans: string[] = [];
    for (const dbPath of dbPaths) {
      if (!scannedPaths.has(dbPath)) {
        orphans.push(dbPath);
      }
    }

    if (orphans.length === 0) {
      log.debug({}, 'no orphans found');
      return;
    }

    const deletionPercentage = dbPaths.length > 0 ? (orphans.length / dbPaths.length) * 100 : 0;
    log.info({ count: orphans.length, percentage: deletionPercentage.toFixed(1) }, 'found orphaned records, cleaning up');

    // Delete each orphan (this will clean up all related data)
    for (const orphanPath of orphans) {
      try {
        const fullPath = path.join(DATA_ROOT, orphanPath);

        // Determine if it was a folder by checking if it has children in DB
        const isFolder = dbPaths.some(p => p.startsWith(`${orphanPath}/`));

        await deleteFile({
          fullPath,
          relativePath: orphanPath,
          isFolder,
        });

        stats.orphansDeleted++;
        log.debug({ path: orphanPath }, 'deleted orphaned record');
      } catch (error) {
        log.error({ err: error, path: orphanPath }, 'failed to delete orphaned record');
        stats.errors++;
      }
    }

    log.info({ deleted: stats.orphansDeleted }, 'orphan cleanup complete');
  } catch (error) {
    log.error({ err: error }, 'orphan cleanup failed');
  }
}
