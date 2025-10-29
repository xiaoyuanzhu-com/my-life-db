/**
 * Task Queue - Main entry point
 *
 * Usage:
 *   // Register handlers
 *   tq('send-email', async (payload) => {
 *     await sendEmail(payload.to, payload.subject, payload.body);
 *   });
 *
 *   // Enqueue tasks
 *   tq('send-email', { to: 'user@example.com', subject: 'Hello', body: 'World' });
 *
 *   // Start worker
 *   startWorker({ verbose: true });
 */

import { createTask } from './task-manager';
import { registerHandler, type TaskHandler } from './executor';
import type { CreateTaskInput } from './task-manager';

/**
 * Main task queue function - Dual purpose:
 * 1. Register handler: tq(type, handler)
 * 2. Enqueue task: tq(type, payload, options?)
 */
export function tq<TPayload = unknown, TResult = unknown>(
  type: string,
  handlerOrPayload: TaskHandler<TPayload, TResult> | TPayload,
  options?: { run_after?: number }
): string | void {
  // Case 1: Register handler (handler is a function)
  if (typeof handlerOrPayload === 'function') {
    registerHandler(type, handlerOrPayload as TaskHandler<TPayload, TResult>);
    return;
  }

  // Case 2: Enqueue task (handler is payload)
  const payload = handlerOrPayload as Record<string, unknown>;
  const task = createTask({
    type,
    payload,
    run_after: options?.run_after,
  });

  return task.id;
}

// Re-export everything for convenience
export * from './task-manager';
export * from './scheduler';
export * from './executor';
export * from './worker';
export * from './uuid';
