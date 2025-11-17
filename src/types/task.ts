/**
 * Task - Tasks table models
 *
 * Background job queue for async operations (AI processing, indexing, etc.).
 * Workers poll this table and execute jobs based on type.
 */

import type { TaskStatus } from './task-status';

/**
 * Task record row (snake_case - matches SQLite schema exactly)
 */
export interface TaskRecordRow {
  /** Task ID (UUID) */
  id: string;

  /** Task type (e.g., 'digest_url_crawl', 'meili_index') */
  type: string;

  /** Input data (JSON string) */
  input: string;

  /** Current status (see TaskStatus enum) */
  status: string;

  /** Version number for optimistic locking */
  version: number;

  /** Number of execution attempts */
  attempts: number;

  /** Unix timestamp (ms) of last execution attempt */
  last_attempt_at: number | null;

  /** Output data (JSON string) - null until completed */
  output: string | null;

  /** Error message if status='failed' */
  error: string | null;

  /** Unix timestamp (ms) - don't execute before this time */
  run_after: number | null;

  /** Unix timestamp (ms) when task was created */
  created_at: number;

  /** Unix timestamp (ms) when task was last updated */
  updated_at: number;

  /** Unix timestamp (ms) when task completed (success or final failure) */
  completed_at: number | null;
}

/**
 * Task record (camelCase - for TypeScript usage)
 *
 * Background job with type-safe input/output and status tracking.
 */
export interface Task<TInput = unknown, TOutput = unknown> {
  /** Task ID (UUID) */
  id: string;

  /** Task type (e.g., 'digest_url_crawl', 'meili_index') */
  type: string;

  /** Input data (parsed from JSON) */
  input: TInput;

  /** Current status (see TaskStatus enum) */
  status: TaskStatus;

  /** Version number for optimistic locking */
  version: number;

  /** Number of execution attempts */
  attempts: number;

  /** Unix timestamp (ms) of last execution attempt */
  lastAttemptAt: number | null;

  /** Output data (parsed from JSON) - null until completed */
  output: TOutput | null;

  /** Error message if status='failed' */
  error: string | null;

  /** Unix timestamp (ms) - don't execute before this time */
  runAfter: number | null;

  /** Unix timestamp (ms) when task was created */
  createdAt: number;

  /** Unix timestamp (ms) when task was last updated */
  updatedAt: number;

  /** Unix timestamp (ms) when task completed (success or final failure) */
  completedAt: number | null;
}

/**
 * Conversion helper: TaskRecordRow → Task
 */
export function rowToTask<TInput = unknown, TOutput = unknown>(
  row: TaskRecordRow
): Task<TInput, TOutput> {
  return {
    id: row.id,
    type: row.type,
    input: JSON.parse(row.input) as TInput,
    status: row.status as TaskStatus,
    version: row.version,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    output: row.output ? (JSON.parse(row.output) as TOutput) : null,
    error: row.error,
    runAfter: row.run_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
