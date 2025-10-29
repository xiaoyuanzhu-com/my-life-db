/**
 * Simple cross-process lock via lock file
 * Ensures only one process performs a critical section (e.g., starts worker)
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { APP_DIR } from '@/lib/fs/storage';

const LOCKS_DIR = path.join(APP_DIR, 'locks');

interface LockInfo {
  pid: number;
  createdAt: string;
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without killing
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err && (err.code === 'ESRCH')) return false; // No such process
    // EPERM or other errors: assume alive to be safe
    return true;
  }
}

async function ensureLocksDir() {
  await fs.mkdir(LOCKS_DIR, { recursive: true });
}

export async function acquireProcessLock(lockName: string): Promise<{
  acquired: boolean;
  lockPath: string;
  ownerPid?: number;
}> {
  await ensureLocksDir();
  const lockPath = path.join(LOCKS_DIR, `${lockName}.lock`);

  try {
    // Attempt exclusive create
    const fd = fsSync.openSync(lockPath, 'wx');
    const info: LockInfo = { pid: process.pid, createdAt: new Date().toISOString() };
    fsSync.writeFileSync(fd, JSON.stringify(info, null, 2));
    fsSync.closeSync(fd);
    return { acquired: true, lockPath };
  } catch (err: any) {
    if (err && err.code === 'EEXIST') {
      try {
        const raw = await fs.readFile(lockPath, 'utf-8');
        const info = JSON.parse(raw) as LockInfo;
        if (!isPidAlive(info.pid)) {
          // Stale lock; remove and retry once
          await fs.rm(lockPath, { force: true });
          return acquireProcessLock(lockName);
        }
        return { acquired: false, lockPath, ownerPid: info.pid };
      } catch {
        // If we can't read/parse, assume locked
        return { acquired: false, lockPath };
      }
    }
    throw err;
  }
}

export async function releaseProcessLock(lockName: string): Promise<void> {
  const lockPath = path.join(LOCKS_DIR, `${lockName}.lock`);
  try {
    // Only remove if we own it
    const raw = await fs.readFile(lockPath, 'utf-8');
    const info = JSON.parse(raw) as LockInfo;
    if (info.pid === process.pid) {
      await fs.rm(lockPath, { force: true });
    }
  } catch {
    // Ignore errors
  }
}

export function setupLockAutoRelease(lockName: string): void {
  const handler = () => {
    releaseProcessLock(lockName).finally(() => process.exit());
  };
  // Register minimal handlers; avoid duplicate registrations
  const key = `__mylifedb_lock_handlers_${lockName}` as const;
  if ((globalThis as any)[key]) return;
  (globalThis as any)[key] = true;

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  process.on('exit', () => { void releaseProcessLock(lockName); });
}

