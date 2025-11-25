import type BetterSqlite3 from 'better-sqlite3';
import { setTimeout as setTimeoutPromise } from 'timers/promises';

import { DigestCoordinator } from './coordinator';
import { findFilesNeedingDigestion } from './file-selection';
import { getDatabase } from '@/lib/db/connection';
import { listDigestsForPath } from '@/lib/db/digests';
import { getLogger } from '@/lib/log/logger';
import { getFileSystemWatcher, type FileChangeEvent } from '@/lib/scanner/fs-watcher';

interface DigestSupervisorConfig {
  startDelayMs: number;
  idleSleepMs: number;
  failureBaseDelayMs: number;
  failureMaxDelayMs: number;
  staleDigestThresholdMs: number;
  staleSweepIntervalMs: number;
  fileDelayMs: number;
}

const DEFAULT_CONFIG: DigestSupervisorConfig = {
  startDelayMs: 10_000,
  idleSleepMs: 1_000, // Changed from 60s to 1s - continuous processing
  failureBaseDelayMs: 5_000,
  failureMaxDelayMs: 60_000,
  staleDigestThresholdMs: 10 * 60 * 1000,
  staleSweepIntervalMs: 60 * 1000,
  fileDelayMs: 1_000,
};

class DigestSupervisor {
  private readonly log = getLogger({ module: 'DigestSupervisor' });
  private readonly config: DigestSupervisorConfig;
  private readonly db: BetterSqlite3.Database;
  private readonly coordinator: DigestCoordinator;
  private running = false;
  private stopped = false;
  private startTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private lastStaleSweep = 0;

  constructor(config?: Partial<DigestSupervisorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = getDatabase();
    this.coordinator = new DigestCoordinator(this.db);
  }

  start(): void {
    if (this.running || this.stopped) {
      return;
    }

    this.running = true;
    this.log.info({ delayMs: this.config.startDelayMs }, 'starting digest supervisor');

    // Subscribe to file system watcher events
    this.subscribeToFileSystemWatcher();

    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.runLoop();
    }, this.config.startDelayMs);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    this.log.debug({}, 'digest supervisor stopped');
  }

  private async runLoop(): Promise<void> {
    this.log.info({}, 'digest supervisor loop started');
    while (!this.stopped) {
      try {
        this.maybeResetStaleDigests();
        const filesToProcess = findFilesNeedingDigestion(this.db, 1);
        const filePath = filesToProcess[0];

        if (!filePath) {
          this.consecutiveFailures = 0;
          await this.sleep(this.config.idleSleepMs);
          continue;
        }

        this.log.debug({ filePath }, 'processing file through digests');
        await this.coordinator.processFile(filePath);

        if (this.config.fileDelayMs > 0) {
          await this.sleep(this.config.fileDelayMs);
        }

        if (this.hasOutstandingFailures(filePath)) {
          this.consecutiveFailures++;
          const delay = this.calculateFailureDelay();
          this.log.error({ filePath, delayMs: delay }, 'digest still failing, backing off');
          await this.sleep(delay);
          continue;
        }

        this.consecutiveFailures = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.consecutiveFailures++;
        const delay = this.calculateFailureDelay();
        this.log.error({ error: message, delayMs: delay }, 'digest processing failed, backing off');
        await this.sleep(delay);
      }
    }
    this.log.info({}, 'digest supervisor loop exited');
  }

  private calculateFailureDelay(): number {
    const exponent = Math.max(this.consecutiveFailures - 1, 0);
    const delay = this.config.failureBaseDelayMs * Math.pow(2, exponent);
    return Math.min(delay, this.config.failureMaxDelayMs);
  }

  private async sleep(ms: number): Promise<void> {
    // Use native timers/promises for better memory efficiency
    // Avoids creating wrapper Promise objects
    await setTimeoutPromise(ms);
  }

  private maybeResetStaleDigests(): void {
    const now = Date.now();
    if (now - this.lastStaleSweep < this.config.staleSweepIntervalMs) {
      return;
    }

    this.lastStaleSweep = now;
    const cutoffIso = new Date(now - this.config.staleDigestThresholdMs).toISOString();
    const result = this.db
      .prepare(
        `
        UPDATE digests
        SET status = 'todo', error = NULL
        WHERE status = 'in-progress'
          AND updated_at < ?
      `
      )
      .run(cutoffIso);

    if (result.changes > 0) {
      this.log.warn({ reset: result.changes }, 'reset stale digest rows');
    }
  }

  private isInCooldown(_filePath: string): boolean {
    return false;
  }

  private hasOutstandingFailures(filePath: string): boolean {
    const digests = listDigestsForPath(filePath);
    return digests.some(digest => digest.status === 'failed');
  }

  /**
   * Subscribe to file system watcher events for immediate processing
   */
  private subscribeToFileSystemWatcher(): void {
    const watcher = getFileSystemWatcher();
    if (!watcher) {
      this.log.debug({}, 'file system watcher not available, skipping subscription');
      return;
    }

    watcher.on('file-change', (event: FileChangeEvent) => {
      this.log.debug({ filePath: event.filePath, isNew: event.isNew }, 'file change event received');
      void this.handleFileChangeEvent(event);
    });

    this.log.info({}, 'subscribed to file system watcher events');
  }

  /**
   * Handle file change events from watcher (immediate processing)
   */
  private async handleFileChangeEvent(event: FileChangeEvent): Promise<void> {
    try {
      const { filePath, isNew, contentChanged, shouldInvalidateDigests } = event;

      // Phase 3 (Future): Invalidate digests if content changed
      if (!isNew && shouldInvalidateDigests) {
        this.log.info({ filePath }, 'file content changed, invalidating existing digests');
        await this.coordinator.processFile(filePath, { reset: true });
        return;
      }

      // Phase 1 & 2: Check if file needs digestion (new files or pending digests)
      const filesToProcess = findFilesNeedingDigestion(this.db, 100);
      const needsWork = filesToProcess.includes(filePath);

      if (!needsWork) {
        this.log.debug({ filePath, isNew, contentChanged }, 'file does not need digestion');
        return;
      }

      this.log.info({ filePath, isNew }, 'processing file immediately from watcher event');
      await this.coordinator.processFile(filePath);

      // Check for failures and apply cooldown if needed
      if (this.hasOutstandingFailures(filePath)) {
        // Keep logging consistent even without cooldown behavior
        this.log.debug({ filePath }, 'file has outstanding failures');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error({ error: message, filePath: event.filePath }, 'failed to process file change event');
    }
  }
}

export function startDigestSupervisor(config?: Partial<DigestSupervisorConfig>): DigestSupervisor {
  const globalState = globalThis as typeof globalThis & {
    __mylifedb_digest_supervisor?: DigestSupervisor;
  };

  if (!globalState.__mylifedb_digest_supervisor) {
    globalState.__mylifedb_digest_supervisor = new DigestSupervisor(config);
    globalState.__mylifedb_digest_supervisor.start();
  }

  return globalState.__mylifedb_digest_supervisor;
}

export function stopDigestSupervisor(): void {
  const globalState = globalThis as typeof globalThis & {
    __mylifedb_digest_supervisor?: DigestSupervisor;
  };

  globalState.__mylifedb_digest_supervisor?.stop();
  globalState.__mylifedb_digest_supervisor = undefined;
}
