/**
 * Local-First Send Queue Types
 *
 * Types for the IndexedDB-based upload queue that enables offline-first sending.
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
 * A single pending inbox item stored in IndexedDB
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

  // Multi-tab lock (heartbeat-based)
  /** Tab ID currently uploading */
  uploadingBy?: string;
  /** Lock timestamp in epoch ms (updated every 1min by uploading tab) */
  uploadingAt?: number;

  // TUS resumable upload tracking
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
 * upload is marked `failed` (terminal) so it doesn't pile up across sessions.
 * Days-long retries were a UX mistake: by the time they fire, the user has
 * forgotten about the file and just sees stale clutter on next page load.
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
  /** IndexedDB database name */
  DB_NAME: 'mylife-inbox-queue',
  /** IndexedDB store name */
  STORE_NAME: 'pending-items',
  /** Database version */
  DB_VERSION: 1,
  /** Maximum concurrent uploads */
  MAX_CONCURRENT_UPLOADS: 6,
  /** Size threshold for simple PUT upload vs TUS (1MB) */
  SIMPLE_UPLOAD_THRESHOLD: 1 * 1024 * 1024,
  /** Lock staleness threshold (1 hour in ms) */
  LOCK_STALE_THRESHOLD_MS: 60 * 60 * 1000,
  /** Heartbeat interval (1 minute in ms) */
  HEARTBEAT_INTERVAL_MS: 60 * 1000,
  /** Upload timeout (3 minutes in ms) */
  UPLOAD_TIMEOUT_MS: 3 * 60 * 1000,
  /** Jitter percentage for retry delays */
  RETRY_JITTER_PERCENT: 0.1,
  /** Max retry attempts before marking item as terminally failed */
  MAX_RETRY_ATTEMPTS: 5,
} as const;
