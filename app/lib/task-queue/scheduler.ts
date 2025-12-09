/**
 * Scheduler - Retry delay calculation and task fetching
 */

import type { Task } from './types';
import { dbSelect, dbSelectOne } from '~/lib/db/client';

/**
 * Calculate retry delay with exponential backoff and jitter
 * Formula: base_delay * 2^(attempt - 1) * (1 + jitter)
 *
 * Default delays (with jitter):
 * - Attempt 1: ~10s
 * - Attempt 2: ~40s
 * - Attempt 3: ~2.6min
 * - Attempt 4: ~10.6min
 * - Attempt 5: ~42.6min
 * - Attempt 6+: ~6hr (capped)
 *
 * @returns delay in seconds
 */
export function calculateRetryDelay(
  attempts: number,
  baseDelaySeconds: number = 10,
  maxDelaySeconds: number = 21600, // 6 hours
  jitterFactor: number = 0.3
): number {
  // Exponential backoff: base * 4^(attempts - 1)
  const exponentialDelay = baseDelaySeconds * Math.pow(4, attempts - 1);

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelaySeconds);

  // Add jitter: random value between -jitterFactor and +jitterFactor
  const jitter = (Math.random() * 2 - 1) * jitterFactor;
  const delayWithJitter = cappedDelay * (1 + jitter);

  return Math.floor(delayWithJitter);
}

/**
 * Get next retry time for a failed task
 */
export function getNextRetryTime(task: Task): number {
  const delay = calculateRetryDelay(task.attempts);
  const lastAttempt = task.last_attempt_at || task.created_at;
  return lastAttempt + delay;
}

/**
 * Query ready tasks (FIFO with run_after support)
 * Returns tasks that:
 * - Status is 'to-do' or 'failed' (with attempts < maxAttempts)
 * - run_after is null or in the past
 * - Ordered by created_at ASC (oldest first, FIFO)
 *
 * @param limit Maximum number of tasks to return
 * @param maxAttempts Maximum attempts before a failed task is considered permanently failed (default: 3)
 */
export function getReadyTasks(limit: number = 10, maxAttempts: number = 3): Task[] {
  const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds

  return dbSelect<Task>(
    `
      SELECT *
      FROM tasks
      WHERE (
        (status = 'to-do')
        OR (status = 'failed' AND attempts < ?)
      )
        AND (run_after IS NULL OR run_after <= ?)
      ORDER BY created_at ASC
      LIMIT ?
    `,
    [maxAttempts, now, limit]
  );
}

/**
 * Get tasks that are stale (in-progress for too long)
 * These tasks likely crashed and should be retried
 */
export function getStaleTasks(timeoutSeconds: number = 300): Task[] {
  const cutoffTime = Math.floor(Date.now() / 1000) - timeoutSeconds;

  return dbSelect<Task>(
    `
      SELECT *
      FROM tasks
      WHERE status = 'in-progress'
        AND last_attempt_at < ?
      ORDER BY last_attempt_at ASC
    `,
    [cutoffTime]
  );
}

/**
 * Get count of pending tasks by type
 */
export function getPendingTaskCountByType(): Record<string, number> {
  const rows = dbSelect<{ type: string; count: number }>(
    `
      SELECT type, COUNT(*) as count
      FROM tasks
      WHERE status IN ('to-do', 'failed', 'in-progress')
      GROUP BY type
    `
  );

  const result: Record<string, number> = {};
  rows.forEach(row => {
    result[row.type] = row.count;
  });

  return result;
}

/**
 * Check if there are any ready tasks
 */
export function hasReadyTasks(): boolean {
  const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds

  const row = dbSelectOne<{ count: number }>(
    `
      SELECT COUNT(*) as count
      FROM tasks
      WHERE status IN ('to-do', 'failed')
        AND (run_after IS NULL OR run_after <= ?)
      LIMIT 1
    `,
    [now]
  );

  return (row?.count ?? 0) > 0;
}

/**
 * Rate limiter using token bucket algorithm
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second

  constructor(rateLimit: number) {
    this.capacity = rateLimit;
    this.refillRate = rateLimit;
    this.tokens = rateLimit;
    this.lastRefill = Date.now();
  }

  /**
   * Try to consume a token
   * @returns true if token consumed, false if rate limit exceeded
   */
  tryConsume(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsedSeconds * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Get time until next token is available (in milliseconds)
   */
  getTimeUntilNextToken(): number {
    if (this.tokens >= 1) {
      return 0;
    }

    const tokensNeeded = 1 - this.tokens;
    const timeMs = (tokensNeeded / this.refillRate) * 1000;
    return Math.ceil(timeMs);
  }
}
