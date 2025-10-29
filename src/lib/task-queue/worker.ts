/**
 * Worker - Background task processing with polling
 */

import { getReadyTasks, getStaleTasks } from './scheduler';
import { executeTask } from './executor';
import { recoverStaleTasks } from './executor';

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

  /** Enable verbose logging (default: false) */
  verbose?: boolean;
}

export class TaskWorker {
  private config: Required<WorkerConfig>;
  private running = false;
  private paused = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private staleRecoveryTimer: NodeJS.Timeout | null = null;

  constructor(config: WorkerConfig = {}) {
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      batchSize: config.batchSize ?? 5,
      maxAttempts: config.maxAttempts ?? 3,
      staleTaskTimeoutSeconds: config.staleTaskTimeoutSeconds ?? 300, // 5 minutes
      staleTaskRecoveryIntervalMs: config.staleTaskRecoveryIntervalMs ?? 60_000,
      verbose: config.verbose ?? false,
    };
  }

  /**
   * Start the worker
   */
  start(): void {
    if (this.running) {
      this.log('Worker already running');
      return;
    }

    this.running = true;
    this.paused = false;
    this.log('Worker started');

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
      this.log('Worker not running');
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

    this.log('Worker stopped');
  }

  /**
   * Pause the worker (stop processing but keep running)
   */
  pause(): void {
    if (!this.running) {
      this.log('Worker not running, cannot pause');
      return;
    }

    this.paused = true;
    this.log('Worker paused');
  }

  /**
   * Resume the worker
   */
  resume(): void {
    if (!this.running) {
      this.log('Worker not running, cannot resume');
      return;
    }

    if (!this.paused) {
      this.log('Worker not paused');
      return;
    }

    this.paused = false;
    this.log('Worker resumed');

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
    if (!this.running) return;

    this.pollTimer = setTimeout(() => {
      this.poll();
    }, this.config.pollIntervalMs);
  }

  /**
   * Schedule next stale recovery
   */
  private scheduleStaleRecovery(): void {
    if (!this.running) return;

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
      if (this.paused) {
        return;
      }

      // Fetch ready tasks
      const tasks = getReadyTasks(this.config.batchSize);

      if (tasks.length === 0) {
        this.log('No ready tasks');
        return;
      }

      this.log(`Processing ${tasks.length} task(s)`);

      // Execute tasks in parallel (up to batchSize)
      const results = await Promise.allSettled(
        tasks.map(task => executeTask(task.id, this.config.maxAttempts))
      );

      // Log results
      let successCount = 0;
      let failedCount = 0;

      results.forEach((result, index) => {
        const task = tasks[index];

        if (result.status === 'fulfilled') {
          const { success, error } = result.value;
          if (success) {
            successCount++;
            this.log(`✓ Task ${task.id} (${task.type}) completed`);
          } else {
            failedCount++;
            this.log(`✗ Task ${task.id} (${task.type}) failed: ${error}`);
          }
        } else {
          failedCount++;
          this.log(`✗ Task ${task.id} (${task.type}) threw error: ${result.reason}`);
        }
      });

      this.log(`Batch complete: ${successCount} succeeded, ${failedCount} failed`);
    } catch (error) {
      console.error('[TaskQueue] Worker poll error:', error);
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
      if (this.paused) {
        return;
      }

      const staleTasks = getStaleTasks(this.config.staleTaskTimeoutSeconds);

      if (staleTasks.length > 0) {
        this.log(`Found ${staleTasks.length} stale task(s), recovering...`);
        const recovered = recoverStaleTasks(staleTasks);
        this.log(`Recovered ${recovered} stale task(s)`);
      }
    } catch (error) {
      console.error('[TaskQueue] Stale recovery error:', error);
    } finally {
      this.scheduleStaleRecovery();
    }
  }

  /**
   * Log message (respects verbose setting)
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(`[TaskQueue Worker] ${message}`);
    }
  }
}

/**
 * Global worker instance (singleton)
 * Store in globalThis to survive hot reloads in development
 */
declare global {
  // eslint-disable-next-line no-var
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
export function startWorker(config?: WorkerConfig): void {
  const worker = getWorker(config);
  worker.start();
}

/**
 * Stop global worker
 */
export function stopWorker(): void {
  const worker = globalThis.__mylifedb_taskqueue_worker;
  if (worker) worker.stop();
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
