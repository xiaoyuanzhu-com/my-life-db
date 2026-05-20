/**
 * Send queue types
 *
 * The queue is session-scoped: items live in memory inside the
 * UploadQueueManager and are gone when the page closes or reloads.
 */

/**
 * Pending item status
 *
 * - `saved`: enqueued, not yet attempted
 * - `uploading`: in flight (or scheduled for retry within the same session)
 * - `uploaded`: server confirmed; waiting for the file-tree sync to clean up
 * - `failed`: terminal failure — will not auto-retry; user must dismiss or re-upload
 */
export type PendingItemStatus = 'saved' | 'uploading' | 'uploaded' | 'failed';

/**
 * A single pending inbox item
 */
export interface PendingInboxItem {
  // Identity
  /** UUID (client-generated, also used as idempotency key) */
  id: string;
  /** Epoch ms timestamp, used for ordering */
  createdAt: number;

  // Content - each item is ONE file (text or binary)
  /** Generated name (text) or original name (file) */
  filename: string;
  /** File data (text saved as .md blob) */
  blob: Blob;
  /** MIME type ('text/markdown' for text, original for files) */
  type: string;
  /** File size in bytes */
  size: number;
  /** Destination path relative to data directory (e.g., 'inbox', 'notes/work', defaults to 'inbox') */
  destination?: string;

  // Sync state
  /** Current status */
  status: PendingItemStatus;
  /** Upload progress 0-100 */
  uploadProgress: number;
  /** Last error message (for display, cleared on retry) */
  errorMessage?: string;

  // Retry metadata
  /** Number of retry attempts */
  retryCount: number;
  /** Epoch ms timestamp for next retry */
  nextRetryAt?: number;
  /** Epoch ms timestamp of last attempt */
  lastAttemptAt?: number;

  // TUS resumable upload tracking (within-session resume across chunk failures)
  /** TUS upload URL for resume */
  tusUploadUrl?: string;
  /** Bytes successfully uploaded */
  tusUploadOffset?: number;

  // Server reference (once uploaded)
  /** Server path (e.g., 'inbox/photo.jpg') */
  serverPath?: string;
  /** Epoch ms timestamp when uploaded */
  uploadedAt?: number;
}

/**
 * Retry backoff delays in milliseconds.
 *
 * Capped at MAX_RETRY_ATTEMPTS attempts (~2.5 min total). After that, the
 * upload is marked `failed` (terminal).
 */
export const RETRY_DELAYS_MS = [
  5_000,      // 5s
  10_000,     // 10s
  20_000,     // 20s
  40_000,     // 40s
  60_000,     // 1min
] as const;

/**
 * Queue constants
 */
export const QUEUE_CONSTANTS = {
  /** Maximum concurrent uploads */
  MAX_CONCURRENT_UPLOADS: 6,
  /** Size threshold for simple PUT upload vs TUS (1MB) */
  SIMPLE_UPLOAD_THRESHOLD: 1 * 1024 * 1024,
  /** Upload timeout (3 minutes in ms) */
  UPLOAD_TIMEOUT_MS: 3 * 60 * 1000,
  /** Jitter percentage for retry delays */
  RETRY_JITTER_PERCENT: 0.1,
  /** Max retry attempts before marking item as terminally failed */
  MAX_RETRY_ATTEMPTS: 5,
} as const;
