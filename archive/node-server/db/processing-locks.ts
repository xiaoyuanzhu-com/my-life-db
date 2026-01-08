/**
 * Database-level locks for digest processing coordination
 * Prevents concurrent processing of the same file across processes/workers
 */
import { dbRun, dbSelectOne } from './client';
import { getLogger } from '~/.server/log/logger';

const log = getLogger({ module: 'ProcessingLocks' });

// Stale lock threshold: 10 minutes
const STALE_LOCK_THRESHOLD_MS = 10 * 60 * 1000;

interface LockRow {
  file_path: string;
  locked_at: string;
  locked_by: string | null;
}

/**
 * Try to acquire a processing lock for a file.
 * Returns true if lock was acquired, false if already locked.
 */
export function tryAcquireLock(filePath: string, lockedBy?: string): boolean {
  const now = new Date().toISOString();

  try {
    // Use INSERT OR IGNORE - will fail silently if lock exists
    const result = dbRun(
      `INSERT OR IGNORE INTO processing_locks (file_path, locked_at, locked_by) VALUES (?, ?, ?)`,
      [filePath, now, lockedBy ?? null]
    );

    if (result.changes > 0) {
      log.debug({ filePath, lockedBy }, 'lock acquired');
      return true;
    }

    // Lock exists - check if it's stale
    const existing = dbSelectOne<LockRow>(
      `SELECT * FROM processing_locks WHERE file_path = ?`,
      [filePath]
    );

    if (existing) {
      const lockAge = Date.now() - new Date(existing.locked_at).getTime();
      if (lockAge > STALE_LOCK_THRESHOLD_MS) {
        // Stale lock - force acquire
        log.warn({ filePath, lockedBy: existing.locked_by, ageMs: lockAge }, 'forcing stale lock');
        dbRun(
          `UPDATE processing_locks SET locked_at = ?, locked_by = ? WHERE file_path = ?`,
          [now, lockedBy ?? null, filePath]
        );
        return true;
      }
    }

    log.debug({ filePath }, 'lock already held');
    return false;
  } catch (error) {
    log.error({ filePath, error }, 'failed to acquire lock');
    return false;
  }
}

/**
 * Release a processing lock for a file
 */
export function releaseLock(filePath: string): void {
  try {
    const result = dbRun(
      `DELETE FROM processing_locks WHERE file_path = ?`,
      [filePath]
    );

    if (result.changes > 0) {
      log.debug({ filePath }, 'lock released');
    }
  } catch (error) {
    log.error({ filePath, error }, 'failed to release lock');
  }
}

/**
 * Check if a file is currently locked
 */
export function isLocked(filePath: string): boolean {
  const row = dbSelectOne<LockRow>(
    `SELECT * FROM processing_locks WHERE file_path = ?`,
    [filePath]
  );

  if (!row) return false;

  // Check if stale
  const lockAge = Date.now() - new Date(row.locked_at).getTime();
  return lockAge <= STALE_LOCK_THRESHOLD_MS;
}

/**
 * Clean up all stale locks
 * Called on startup to recover from crashed processes
 */
export function cleanupStaleLocks(): number {
  const cutoff = new Date(Date.now() - STALE_LOCK_THRESHOLD_MS).toISOString();

  const result = dbRun(
    `DELETE FROM processing_locks WHERE locked_at < ?`,
    [cutoff]
  );

  if (result.changes > 0) {
    log.info({ removed: result.changes }, 'cleaned up stale locks');
  }

  return result.changes;
}
