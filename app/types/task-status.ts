/**
 * Task Status - tracks background job state
 *
 * Lifecycle: to-do → in-progress → success (or failed → to-do for retry)
 *
 * Values:
 * - to-do: Queued for execution
 * - in-progress: Currently executing
 * - success: Completed successfully
 * - failed: Execution failed (may be retried)
 */
export type TaskStatus = 'to-do' | 'in-progress' | 'success' | 'failed';
