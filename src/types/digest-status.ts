/**
 * Digest Status - tracks AI processing state for digests
 *
 * Lifecycle: todo → in-progress → completed (or failed/skipped)
 *
 * Values:
 * - todo: Queued for processing, not started yet
 * - in-progress: Currently being processed by AI
 * - completed: Successfully processed and completed
 * - failed: Processing failed (see error field)
 * - skipped: Intentionally skipped (not applicable for this file)
 */
export type DigestStatus = 'todo' | 'in-progress' | 'completed' | 'failed' | 'skipped';
