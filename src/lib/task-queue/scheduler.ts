/**
 * Scheduler - Retry delay calculation and task fetching
 */

import { getDatabase } from '../db/connection';
import type { Task } from './task-manager';

/**
 * Calculate retry delay with exponential backoff and jitter
 * Formula: base_delay * 2^(attempt - 1) * (1 + jitter)
 *
 * Default delays (with jitter):
 * - Attempt 1: ~10s
 * - Attempt 2: ~20s
 * - Attempt 3: ~40s
 * - Attempt 4: ~80s
 * - Attempt 5+: ~160s (capped)
 */
export function calculateRetryDelay(
  attempts: number,
  baseDelayMs: number = 10_000,
  maxDelayMs: number = 160_000,
  jitterFactor: number = 0.3
): number {
  // Exponential backoff: base * 2^(attempts - 1)
  const exponentialDelay = baseDelayMs * Math.pow(2, attempts - 1);

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

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
 * - Status is 'to-do' or 'failed'
 * - run_after is null or in the past
 * - Ordered by created_at ASC (oldest first)
 */
export function getReadyTasks(limit: number = 10): Task[] {
  const db = getDatabase();
  const now = Date.now();

  const stmt = db.prepare(`
    SELECT *
    FROM tasks
    WHERE status IN ('to-do', 'failed')
      AND (run_after IS NULL OR run_after <= ?)
    ORDER BY created_at ASC
    LIMIT ?
  `);

  return stmt.all(now, limit) as Task[];
}

/**
 * Get tasks that are stale (in-progress for too long)
 * These tasks likely crashed and should be retried
 */
export function getStaleTasks(timeoutMs: number = 300_000): Task[] {
  const db = getDatabase();
  const cutoffTime = Date.now() - timeoutMs;

  const stmt = db.prepare(`
    SELECT *
    FROM tasks
    WHERE status = 'in-progress'
      AND last_attempt_at < ?
    ORDER BY last_attempt_at ASC
  `);

  return stmt.all(cutoffTime) as Task[];
}

/**
 * Get count of pending tasks by type
 */
export function getPendingTaskCountByType(): Record<string, number> {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT type, COUNT(*) as count
    FROM tasks
    WHERE status IN ('to-do', 'failed', 'in-progress')
    GROUP BY type
  `).all() as Array<{ type: string; count: number }>;

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
  const db = getDatabase();
  const now = Date.now();

  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM tasks
    WHERE status IN ('to-do', 'failed')
      AND (run_after IS NULL OR run_after <= ?)
    LIMIT 1
  `).get(now) as { count: number };

  return row.count > 0;
}
