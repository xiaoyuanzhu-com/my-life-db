/**
 * Executor - Task execution with handler registry
 */

import { getTaskById, updateTask } from './task-manager';
import type { Task, TaskHandler } from './types';
import { upsertInboxTaskState } from '../db/inboxTaskState';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'TaskExecutor' });

/**
 * Global handler registry
 */
const handlers = new Map<string, TaskHandler>();

/**
 * Register a task handler
 */
export function registerHandler<TPayload = unknown>(
  type: string,
  handler: TaskHandler<TPayload>
): void {
  if (handlers.has(type)) {
    log.warn({ type }, 'handler already registered, overwriting');
  }
  // Type assertion is safe because we're handling the generic properly at call sites
  handlers.set(type, handler as TaskHandler);
}

/**
 * Unregister a task handler
 */
export function unregisterHandler(type: string): boolean {
  return handlers.delete(type);
}

/**
 * Get registered handler for a task type
 */
export function getHandler(type: string): TaskHandler | undefined {
  return handlers.get(type);
}

/**
 * List all registered handler types
 */
export function getRegisteredHandlers(): string[] {
  return Array.from(handlers.keys());
}

/**
 * Execute a task with optimistic locking
 * Returns execution output or error
 */
export async function executeTask(
  taskId: string,
  maxAttempts: number = 3
): Promise<{
  success: boolean;
  output?: unknown;
  error?: string;
  shouldRetry: boolean;
}> {
  // 1. Fetch task
  const task = getTaskById(taskId);
  if (!task) {
    return {
      success: false,
      error: 'Task not found',
      shouldRetry: false,
    };
  }

  // 2. Check if task is already complete
  if (task.status === 'success') {
    return {
      success: true,
      output: task.output ? JSON.parse(task.output) : null,
      shouldRetry: false,
    };
  }

  // 3. Check max attempts
  if (task.attempts >= maxAttempts) {
    return {
      success: false,
      error: `Max attempts (${maxAttempts}) reached`,
      shouldRetry: false,
    };
  }

  // 4. Try to claim task with optimistic locking
  const claimed = updateTask(
    taskId,
    {
      status: 'in-progress',
      attempts: task.attempts + 1,
      last_attempt_at: Math.floor(Date.now() / 1000), // Unix timestamp in seconds
    },
    task.version
  );

  if (!claimed) {
    // Version mismatch - another worker claimed it
    return {
      success: false,
      error: 'Task already claimed by another worker',
      shouldRetry: false,
    };
  }

  // 5. Get fresh task after claiming
  const claimedTask = getTaskById(taskId);
  if (!claimedTask) {
    return {
      success: false,
      error: 'Task disappeared after claiming',
      shouldRetry: false,
    };
  }

  // 5.1 Update projection for inbox tasks to in-progress
  try {
    const inputObj = JSON.parse(task.input) as Record<string, unknown>;
    const inboxId = typeof inputObj?.inboxId === 'string' ? (inputObj.inboxId as string) : null;
    if (inboxId) {
      upsertInboxTaskState({
        inboxId,
        taskType: task.type,
        status: 'in-progress',
        taskId: task.id,
        attempts: claimedTask.attempts,
        error: null,
      });
    }
  } catch {
    // ignore input parse errors for projection
  }

  // 6. Get handler
  const handler = getHandler(task.type);
  if (!handler) {
    // No handler registered - mark as failed permanently
    updateTask(
      taskId,
      {
        status: 'failed',
        error: `No handler registered for task type "${task.type}"`,
        output: `No handler registered for task type "${task.type}"`,
      },
      claimedTask.version
    );

    // Update projection: failed (permanent)
    try {
      const inputObj2 = JSON.parse(task.input) as Record<string, unknown>;
      const inboxId = typeof inputObj2?.inboxId === 'string' ? (inputObj2.inboxId as string) : null;
      if (inboxId) {
        upsertInboxTaskState({
          inboxId,
          taskType: task.type,
          status: 'failed',
          taskId: task.id,
          attempts: claimedTask.attempts,
          error: `No handler registered for task type "${task.type}"`,
        });
      }
    } catch {}

    return {
      success: false,
      error: `No handler registered for task type "${task.type}"`,
      shouldRetry: false,
    };
  }

  // 7. Execute handler
  try {
    const input = JSON.parse(task.input);
    const output = await handler(input);

    // 8. Mark as success
    const updated = updateTask(
      taskId,
      {
        status: 'success',
        output: output as Record<string, unknown>,
      },
      claimedTask.version
    );

    if (!updated) {
      // Version mismatch - task was modified during execution
      log.warn({ taskId }, 'version conflict after executing task');
    }

    // Update projection: success
    try {
      const inputObj3 = input as Record<string, unknown>;
      const inboxId = typeof inputObj3?.inboxId === 'string' ? (inputObj3.inboxId as string) : null;
      if (inboxId) {
        upsertInboxTaskState({
          inboxId,
          taskType: task.type,
          status: 'success',
          taskId: task.id,
          attempts: claimedTask.attempts,
          error: null,
        });
      }
    } catch {}

    return {
      success: true,
      output,
      shouldRetry: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const shouldRetry = claimedTask.attempts < maxAttempts;

    // 9. Mark as failed (will retry if attempts < max)
    updateTask(
      taskId,
      {
        status: shouldRetry ? 'failed' : 'failed',
        error: errorMessage,
        // Also record the error in output as requested
        output: errorMessage,
      },
      claimedTask.version
    );

    // Update projection: failed
    try {
      const inputObj4 = JSON.parse(task.input) as Record<string, unknown>;
      const inboxId = typeof inputObj4?.inboxId === 'string' ? (inputObj4.inboxId as string) : null;
      if (inboxId) {
        upsertInboxTaskState({
          inboxId,
          taskType: task.type,
          status: 'failed',
          taskId: task.id,
          attempts: claimedTask.attempts,
          error: errorMessage,
        });
      }
    } catch {}

    return {
      success: false,
      error: errorMessage,
      shouldRetry,
    };
  }
}

/**
 * Recover stale tasks (tasks stuck in 'in-progress')
 * Resets them to 'failed' so they can be retried
 */
export function recoverStaleTasks(tasks: Task[]): number {
  let recovered = 0;

  for (const task of tasks) {
    const updated = updateTask(
      task.id,
      {
        status: 'failed',
        error: 'Task timed out (stale task recovery)',
        output: 'Task timed out (stale task recovery)',
      },
      task.version
    );

    if (updated) {
      recovered++;
      log.info({ taskId: task.id, type: task.type }, 'recovered stale task');

      // Update projection: failed due to timeout
      try {
        const inputObj = JSON.parse(task.input) as Record<string, unknown>;
        const inboxId = typeof inputObj?.inboxId === 'string' ? (inputObj.inboxId as string) : null;
        if (inboxId) {
          upsertInboxTaskState({
            inboxId,
            taskType: task.type,
            status: 'failed',
            taskId: task.id,
            attempts: task.attempts,
            error: 'Task timed out (stale task recovery)',
          });
        }
      } catch {}
    }
  }

  return recovered;
}
