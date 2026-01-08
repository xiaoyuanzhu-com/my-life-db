/**
 * Worker Thread Message Types
 *
 * Shared type definitions for communication between main thread and workers.
 */

// ============================================================================
// FS Worker Messages
// ============================================================================

/** Messages sent TO the FS worker */
export type FsWorkerInMessage =
  | { type: 'shutdown' };

/** Messages sent FROM the FS worker */
export type FsWorkerOutMessage =
  | { type: 'ready' }
  | { type: 'inbox-changed'; timestamp: string }
  | { type: 'file-change'; filePath: string; isNew: boolean; contentChanged: boolean }
  | { type: 'shutdown-complete' };

// ============================================================================
// Digest Worker Messages
// ============================================================================

/** Messages sent TO the digest worker */
export type DigestWorkerInMessage =
  | { type: 'digest'; filePath: string; reset?: boolean; digester?: string }
  | { type: 'file-change'; filePath: string; isNew: boolean; contentChanged: boolean }
  | { type: 'shutdown' };

/** Messages sent FROM the digest worker */
export type DigestWorkerOutMessage =
  | { type: 'ready' }
  | { type: 'digest-started'; filePath: string }
  | { type: 'digest-complete'; filePath: string; success: boolean }
  | { type: 'shutdown-complete' };
