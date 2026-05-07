/**
 * draft-outbox — types
 *
 * Single source of truth for what a draft and an outbox item look like, and
 * the shape of every signal that crosses this module's boundary.
 */

/** Connection state of the underlying transport (WebSocket). */
export type ConnState = "open" | "closed" | "reconnecting"

/** Lifecycle state of an outbox item. */
export type OutboxItemState = "pending" | "inflight" | "failed"

/** Reference to an attachment held in another module (e.g. send-queue). */
export interface AttachmentRef {
  /** Stable id understood by the layer that owns the actual blob. */
  id: string
  /** Display name; informational only. */
  name?: string
}

/** A single prompt the user submitted, awaiting server acknowledgement. */
export interface OutboxItem {
  /**
   * Client-generated id. Doubles as the message id rendered by the UI:
   * the frontend mints it, sends it on `session.prompt`, the backend echoes
   * it back on `user_message_chunk`, and the same string identifies the
   * rendered ThreadMessageLike. Used for ack matching and server-side dedup.
   */
  messageId: string
  sessionId: string
  text: string
  attachments: AttachmentRef[]
  /** Epoch ms; preserves submit order. */
  createdAt: number
  state: OutboxItemState
  /** Number of flush attempts so far. */
  attempts: number
  /** Last failure reason — for UI surface and diagnosis. */
  lastError?: string
}

/** Aggregated counts used by UI affordances (badges, banners). */
export interface OutboxAggregateState {
  sessionId: string
  pending: number
  inflight: number
  failed: number
  total: number
}

// ── Signals OUT (events the module emits) ─────────────────────────────────

export type OutboxEvent =
  | { type: "draftRestored"; sessionId: string; text: string }
  | { type: "draftCleared"; sessionId: string }
  | { type: "flushItem"; item: OutboxItem }
  | { type: "outboxStateChanged"; state: OutboxAggregateState }
  | {
      type: "itemFailed"
      messageId: string
      reason: string
      retryable: boolean
    }
  | {
      type: "log"
      level: "info" | "warn" | "error"
      msg: string
      fields?: Record<string, unknown>
    }

export type OutboxSubscriber = (event: OutboxEvent) => void
export type Unsubscribe = () => void

// ── Diagnostic counters (in-memory only) ──────────────────────────────────

export interface OutboxDiagnostics {
  drafts: { persisted: number; restored: number; cleared: number }
  outbox: { enqueued: number; acked: number; failed: number; requeued: number }
  signalsIn: Record<string, number>
  signalsOut: Record<string, number>
}
