/**
 * Task Queue - Main entry point
 *
 * Usage:
 *   // Configure task type
 *   tq('crawl')
 *     .setWorker(async (input) => { ... })
 *     .setWorkerCount(3)
 *     .setRateLimit(10)
 *     .setTimeout(5000)
 *     .setMaxAttempts(5);
 *
 *   // Enqueue tasks
 *   tq('crawl').add({ url: 'https://example.com' });
 *
 *   // Start worker
 *   startWorker({ verbose: true });
 */

import { createTask } from './task-manager';
import { registerHandler } from './executor';
import { RateLimiter } from './scheduler';
import type { TaskHandler, TaskInput, TaskTypeConfig } from './types';

/**
 * Task type configurations (per task type)
 */
const taskTypeConfigs = new Map<string, Partial<TaskTypeConfig>>();

/**
 * Rate limiters per task type
 */
const rateLimiters = new Map<string, RateLimiter>();

/**
 * Task queue builder for configuring and adding tasks
 */
class TaskQueueBuilder {
  constructor(private type: string) {}

  /**
   * Set worker handler for this task type
   */
  setWorker<T = TaskInput>(handler: TaskHandler<T>): this {
    registerHandler(this.type, handler as TaskHandler);
    this.getConfig().handler = handler as TaskHandler;
    return this;
  }

  /**
   * Set worker count (number of concurrent tasks) - NOT IMPLEMENTED YET
   * Note: Current implementation uses global worker with batchSize
   */
  setWorkerCount(count: number): this {
    this.getConfig().workerCount = count;
    return this;
  }

  /**
   * Set rate limit (requests per second)
   */
  setRateLimit(rateLimit: number): this {
    this.getConfig().rateLimit = rateLimit;
    rateLimiters.set(this.type, new RateLimiter(rateLimit));
    return this;
  }

  /**
   * Set timeout (in milliseconds)
   */
  setTimeout(timeoutMs: number): this {
    this.getConfig().timeout = timeoutMs;
    return this;
  }

  /**
   * Set max attempts for retries
   */
  setMaxAttempts(maxAttempts: number): this {
    this.getConfig().maxAttempts = maxAttempts;
    return this;
  }

  /**
   * Add a task to the queue
   */
  add(input: TaskInput, runAfter?: number): string {
    // Check rate limit
    const rateLimiter = rateLimiters.get(this.type);
    if (rateLimiter && !rateLimiter.tryConsume()) {
      const waitTime = rateLimiter.getTimeUntilNextToken();
      const runAfterWithRateLimit = Math.floor(Date.now() / 1000) + Math.ceil(waitTime / 1000);
      runAfter = runAfter ? Math.max(runAfter, runAfterWithRateLimit) : runAfterWithRateLimit;
    }

    const task = createTask({
      type: this.type,
      input,
      run_after: runAfter,
    });

    return task.id;
  }

  /**
   * Get or create config for this task type
   */
  private getConfig(): Partial<TaskTypeConfig> {
    if (!taskTypeConfigs.has(this.type)) {
      taskTypeConfigs.set(this.type, {
        type: this.type,
        workerCount: 1,
        rateLimit: null,
        timeout: 30000, // 30 seconds default
        maxAttempts: 3,
      });
    }
    return taskTypeConfigs.get(this.type)!;
  }
}

/**
 * Main task queue function
 * Returns a builder for configuring and adding tasks
 */
export function tq(type: string): TaskQueueBuilder {
  return new TaskQueueBuilder(type);
}

/**
 * Get task type configuration
 */
export function getTaskTypeConfig(type: string): Partial<TaskTypeConfig> | undefined {
  return taskTypeConfigs.get(type);
}

// Re-export everything for convenience
export * from './types';
export * from './task-manager';
export * from './scheduler';
export * from './executor';
export { TaskWorker, getWorker, startWorker, stopWorker, pauseWorker, resumeWorker } from './worker';
export * from './uuid';
