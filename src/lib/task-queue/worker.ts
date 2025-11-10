/**
 * Worker - Background task processing with polling
 */

import { getReadyTasks, getStaleTasks } from './scheduler';
import { executeTask } from './executor';
import { recoverStaleTasks } from './executor';
import { getLogger } from '@/lib/log/logger';

export interface WorkerConfig {
  /** Polling interval in milliseconds (default: 1000ms) */
  pollIntervalMs?: number;

  /** Batch size for processing tasks (default: 5) */
  batchSize?: number;

  /** Maximum attempts per task (default: 3) */
  maxAttempts?: number;

  /** Stale task timeout in seconds (default: 300s = 5 minutes) */
  staleTaskTimeoutSeconds?: number;

  /** Stale task recovery interval (default: 60000ms = 1 minute) */
  staleTaskRecoveryIntervalMs?: number;
}

export class TaskWorker {
  private config: Required<WorkerConfig>;
  private running = false;
  private paused = false;
  private stopping = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private staleRecoveryTimer: NodeJS.Timeout | null = null;
  private activeTasks = new Set<Promise<unknown>>();
  private logger = getLogger({ module: 'TaskQueueWorker' });

  constructor(config: WorkerConfig = {}) {
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      batchSize: config.batchSize ?? 5,
      maxAttempts: config.maxAttempts ?? 3,
      staleTaskTimeoutSeconds: config.staleTaskTimeoutSeconds ?? 300, // 5 minutes
      staleTaskRecoveryIntervalMs: config.staleTaskRecoveryIntervalMs ?? 60_000,
    };
  }

  /**
   * Start the worker
   */
  start(): void {
    if (this.running) {
      this.logger.debug({}, 'worker already running');
      return;
    }

    this.running = true;
    this.paused = false;
     this.stopping = false;
    this.logger.info({}, 'worker started');

    // Start polling loop
    this.schedulePoll();

    // Start stale task recovery
    this.scheduleStaleRecovery();
  }

  /**
   * Stop the worker
   */
  stop(): void {
    if (!this.running) {
      this.logger.debug({}, 'worker not running');
      return;
    }

    this.running = false;
    this.paused = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.staleRecoveryTimer) {
      clearTimeout(this.staleRecoveryTimer);
      this.staleRecoveryTimer = null;
    }

    this.logger.info({}, 'worker stopped');
  }

  /**
   * Gracefully stop the worker, waiting for active tasks (with timeout)
   */
  async shutdown(options?: { timeoutMs?: number; reason?: string }): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    this.logger.info({ reason: options?.reason }, 'worker shutting down');
    this.stop();

    const timeoutMs = options?.timeoutMs ?? 10_000;
    const pendingBefore = this.activeTasks.size;
    if (pendingBefore === 0) {
      this.logger.info({}, 'worker shutdown complete (no pending tasks)');
      this.stopping = false;
      return;
    }

    await this.waitForActiveTasks(timeoutMs);

    if (this.activeTasks.size === 0) {
      this.logger.info({}, 'worker shutdown complete');
    } else {
      this.logger.warn(
        { pending: this.activeTasks.size },
        'worker shutdown timed out while waiting for tasks'
      );
    }
    this.stopping = false;
  }

  /**
   * Pause the worker (stop processing but keep running)
   */
  pause(): void {
    if (!this.running) {
      this.logger.debug({}, 'worker not running, cannot pause');
      return;
    }

    this.paused = true;
    this.logger.info({}, 'worker paused');
  }

  /**
   * Resume the worker
   */
  resume(): void {
    if (!this.running) {
      this.logger.debug({}, 'worker not running, cannot resume');
      return;
    }

    if (!this.paused) {
      this.logger.debug({}, 'worker not paused');
      return;
    }

    this.paused = false;
    this.logger.info({}, 'worker resumed');

    // Immediately poll for tasks
    this.poll();
  }

  /**
   * Check if worker is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Check if worker is paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Schedule next poll
   */
  private schedulePoll(): void {
    if (!this.running || this.stopping) return;

    this.pollTimer = setTimeout(() => {
      this.poll();
    }, this.config.pollIntervalMs);
  }

  /**
   * Schedule next stale recovery
   */
  private scheduleStaleRecovery(): void {
    if (!this.running || this.stopping) return;

    this.staleRecoveryTimer = setTimeout(() => {
      this.recoverStale();
    }, this.config.staleTaskRecoveryIntervalMs);
  }

  /**
   * Poll for ready tasks and execute them
   */
  private async poll(): Promise<void> {
    try {
      // Skip if paused
      if (this.paused || this.stopping) {
        return;
      }

      // Fetch ready tasks (already filtered by SQL to exclude failed tasks with attempts >= maxAttempts)
      const readyTasks = getReadyTasks(this.config.batchSize, this.config.maxAttempts);

      if (readyTasks.length === 0) {
        this.logger.debug({}, 'no ready tasks');
        return;
      }

      this.logger.info({ count: readyTasks.length }, 'processing tasks');

      // Execute tasks in parallel (up to batchSize)
      const results = await Promise.allSettled(
        readyTasks.map(task => this.trackExecution(executeTask(task.id, this.config.maxAttempts)))
      );

      // Log results
      let successCount = 0;
      let failedCount = 0;

      results.forEach((result, index) => {
        const task = readyTasks[index];

        if (result.status === 'fulfilled') {
          const { success, error } = result.value;
          if (success) {
            successCount++;
            this.logger.info({ taskId: task.id, type: task.type }, 'task completed');
          } else {
            failedCount++;
            this.logger.error({ taskId: task.id, type: task.type, error }, 'task failed');
          }
        } else {
          failedCount++;
          this.logger.error({ taskId: task.id, type: task.type, error: result.reason }, 'task threw error');
        }
      });

      this.logger.info({ successCount, failedCount }, 'batch complete');
    } catch (error) {
      this.logger.error({ err: error }, 'worker poll error');
    } finally {
      // Schedule next poll
      this.schedulePoll();
    }
  }

  /**
   * Recover stale tasks
   */
  private recoverStale(): void {
    try {
      if (this.paused || this.stopping) {
        return;
      }

      const staleTasks = getStaleTasks(this.config.staleTaskTimeoutSeconds);

      if (staleTasks.length > 0) {
        this.logger.info({ count: staleTasks.length }, 'recovering stale tasks');
        const recovered = recoverStaleTasks(staleTasks);
        this.logger.info({ recovered }, 'stale tasks recovered');
      }
    } catch (error) {
      this.logger.error({ err: error }, 'stale recovery error');
    } finally {
      this.scheduleStaleRecovery();
    }
  }

  private trackExecution<T>(promise: Promise<T>): Promise<T> {
    this.activeTasks.add(promise);
    return promise.finally(() => {
      this.activeTasks.delete(promise);
    });
  }

  private async waitForActiveTasks(timeoutMs: number): Promise<void> {
    if (this.activeTasks.size === 0) {
      return;
    }

    const active = Array.from(this.activeTasks);
    await Promise.race([
      Promise.allSettled(active).then(() => undefined),
      new Promise<void>(resolve => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
  }
}

/**
 * Global worker instance (singleton)
 * Store in globalThis to survive hot reloads in development
 */
declare global {
  var __mylifedb_taskqueue_worker: TaskWorker | undefined;
}

/**
 * Get or create global worker
 */
export function getWorker(config?: WorkerConfig): TaskWorker {
  if (!globalThis.__mylifedb_taskqueue_worker) {
    globalThis.__mylifedb_taskqueue_worker = new TaskWorker(config);
  }
  return globalThis.__mylifedb_taskqueue_worker;
}

/**
 * Start global worker
 */
export function startWorker(config?: WorkerConfig): TaskWorker {
  const existing = globalThis.__mylifedb_taskqueue_worker;
  const shouldRestart = Boolean(
    existing &&
    process.env.NODE_ENV !== 'production'
  );

  if (shouldRestart && existing) {
    void existing.shutdown({ reason: 'hot-reload restart', timeoutMs: 2000 });
    globalThis.__mylifedb_taskqueue_worker = new TaskWorker(config);
  } else if (!existing) {
    globalThis.__mylifedb_taskqueue_worker = new TaskWorker(config);
  }

  const worker = globalThis.__mylifedb_taskqueue_worker;
  if (!worker) {
    throw new Error('Failed to initialize task queue worker');
  }
  worker.start();
  return worker;
}

/**
 * Stop global worker
 */
export function stopWorker(): void {
  const worker = globalThis.__mylifedb_taskqueue_worker;
  if (worker) worker.stop();
}

/**
 * Gracefully shutdown the global worker
 */
export async function shutdownWorker(options?: { timeoutMs?: number; reason?: string }): Promise<void> {
  const worker = globalThis.__mylifedb_taskqueue_worker;
  if (worker) {
    await worker.shutdown(options);
  }
}

/**
 * Pause global worker
 */
export function pauseWorker(): void {
  const worker = globalThis.__mylifedb_taskqueue_worker;
  if (worker) worker.pause();
}

/**
 * Resume global worker
 */
export function resumeWorker(): void {
  const worker = globalThis.__mylifedb_taskqueue_worker;
  if (worker) worker.resume();
}
