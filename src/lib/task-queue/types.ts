/**
 * Task Queue Type Definitions
 */

/**
 * Task status values
 */
export type TaskStatus = 'to-do' | 'in-progress' | 'success' | 'failed';

/**
 * Task record in database
 */
export interface Task {
  id: string;
  type: string;
  payload: string; // JSON string
  status: TaskStatus;
  version: number;
  attempts: number;
  last_attempt_at: number | null;
  result: string | null; // JSON string
  error: string | null;
  run_after: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

/**
 * Task payload (generic)
 */
export type TaskPayload = Record<string, unknown>;

/**
 * Task handler function
 */
export type TaskHandler<T = TaskPayload> = (payload: T) => Promise<unknown>;

/**
 * Task configuration for a specific task type
 */
export interface TaskTypeConfig {
  type: string;
  handler: TaskHandler;
  workerCount: number;
  rateLimit: number | null; // requests per second, null = unlimited
  timeout: number; // milliseconds
  maxAttempts: number;
}

/**
 * Worker configuration
 */
export interface WorkerConfig {
  pollIntervalMs: number;
  batchSize: number;
  staleTaskTimeoutMs: number;
  staleTaskRecoveryIntervalMs: number;
  verbose: boolean;
}

/**
 * Rate limiter state (token bucket)
 */
export interface RateLimiterState {
  tokens: number;
  lastRefill: number;
}

/**
 * Task statistics
 */
export interface TaskStats {
  total: number;
  'to-do': number;
  'in-progress': number;
  success: number;
  failed: number;
}

/**
 * Task type statistics
 */
export interface TaskTypeStats {
  type: string;
  total: number;
  'to-do': number;
  'in-progress': number;
  success: number;
  failed: number;
}
