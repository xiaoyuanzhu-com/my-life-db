/**
 * Local-First Send Queue Types
 *
 * Types for the IndexedDB-based upload queue that enables offline-first sending.
 */

/**
 * Pending item status
 */
export type PendingItemStatus = 'saved' | 'uploading' | 'uploaded';

/**
 * A single pending inbox item stored in IndexedDB
 */
export interface PendingInboxItem {
  // Identity
  /** UUID (client-generated, also used as idempotency key) */
  id: string;
  /** ISO timestamp, used for ordering */
  createdAt: string;

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
  /** ISO timestamp for next retry */
  nextRetryAt?: string;
  /** ISO timestamp of last attempt */
  lastAttemptAt?: string;

  // Multi-tab lock (heartbeat-based)
  /** Tab ID currently uploading */
  uploadingBy?: string;
  /** Lock timestamp (updated every 1min by uploading tab) */
  uploadingAt?: string;

  // TUS resumable upload tracking
  /** TUS upload URL for resume */
  tusUploadUrl?: string;
  /** Bytes successfully uploaded */
  tusUploadOffset?: number;

  // Server reference (once uploaded)
  /** Server path (e.g., 'inbox/photo.jpg') */
  serverPath?: string;
  /** ISO timestamp when uploaded */
  uploadedAt?: string;
}

/**
 * Retry backoff delays in milliseconds
 * Exponential backoff: 5s, 10s, 20s, 40s, 1min, 2min, 5min, 10min, 30min, 1hr, 1day
 */
export const RETRY_DELAYS_MS = [
  5_000,      // 5s
  10_000,     // 10s
  20_000,     // 20s
  40_000,     // 40s
  60_000,     // 1min
  120_000,    // 2min
  300_000,    // 5min
  600_000,    // 10min
  1_800_000,  // 30min
  3_600_000,  // 1hr
  86_400_000, // 1day (max)
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
} as const;
