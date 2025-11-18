import type BetterSqlite3 from 'better-sqlite3';

import { DigestCoordinator } from './coordinator';
import { findFilesNeedingDigestion } from './file-selection';
import { getDatabase } from '@/lib/db/connection';
import { getLogger } from '@/lib/log/logger';

interface DigestSupervisorConfig {
  startDelayMs: number;
  idleSleepMs: number;
  failureBaseDelayMs: number;
  failureMaxDelayMs: number;
  staleDigestThresholdMs: number;
  staleSweepIntervalMs: number;
}

const DEFAULT_CONFIG: DigestSupervisorConfig = {
  startDelayMs: 10_000,
  idleSleepMs: 60_000,
  failureBaseDelayMs: 5_000,
  failureMaxDelayMs: 60_000,
  staleDigestThresholdMs: 10 * 60 * 1000,
  staleSweepIntervalMs: 60 * 1000,
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
    this.log.info({}, 'digest supervisor stopped');
  }

  private async runLoop(): Promise<void> {
    this.log.info({}, 'digest supervisor loop started');
    while (!this.stopped) {
      try {
        this.maybeResetStaleDigests();
        const filesToProcess = findFilesNeedingDigestion(this.db, 1);

        if (filesToProcess.length === 0) {
          this.consecutiveFailures = 0;
          await this.sleep(this.config.idleSleepMs);
          continue;
        }

        const filePath = filesToProcess[0];
        this.log.info({ filePath }, 'processing file through digests');
        await this.coordinator.processFile(filePath);
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
    await new Promise((resolve) => setTimeout(resolve, ms));
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
