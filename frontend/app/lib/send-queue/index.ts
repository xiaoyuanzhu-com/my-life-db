/**
 * Send Queue
 *
 * Session-scoped queue for outbound uploads. State lives in memory on the
 * UploadQueueManager singleton — page reload starts fresh.
 *
 * Supports TUS resumable uploads (within a session), retry with backoff,
 * and bounded concurrency.
 */

export type { PendingInboxItem, PendingItemStatus } from './types';
export { QUEUE_CONSTANTS, RETRY_DELAYS_MS } from './types';
export { UploadQueueManager, getUploadQueueManager } from './upload-queue-manager';
export { generateTextFilename, deduplicateFilename } from './filename';
export { useSendQueue } from './use-send-queue';
export { pendingItemToFile, usePendingItemAsFile } from './pending-to-file';
