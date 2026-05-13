/**
 * draft-outbox — core state machine.
 *
 * One DraftOutbox instance per (sessionId). All inputs are explicit method
 * calls (signals IN). All outputs flow through a single subscriber stream
 * (signals OUT). Internal state is only mutated via these signals.
 *
 * Invariants this module enforces:
 *
 *   I1 — every typed character lives in storage OR composer text (or both).
 *        Implementation: saveDraft on every userTyped, loadDraft on
 *        mountSession before any other input is accepted.
 *
 *   I2 — drafts are only removed by userDiscardedDraft or by userSubmitted
 *        (the text is moved into the outbox in the same synchronous step,
 *        so durability is preserved).
 *
 *   I3 — outbox items are only removed by serverAcked. ws.send returning
 *        truthy moves pending → inflight; nothing more.
 *
 *   I4 — mountSession runs loadDraft + emits draftRestored before returning.
 *
 *   I5 — mountSession reads outbox; pending items are queued for flush
 *        (emitted as flushItem when connectionChanged('open') runs).
 *
 *   I6 — every public method emits a structured log line.
 */

import { generateUUID } from "../uuid"
import { logger } from "./logger"
import {
  clearDraft,
  initStorage,
  loadDraft,
  loadOutbox,
  saveDraft,
  saveOutbox,
} from "./storage"
import type {
  AttachmentRef,
  ConnState,
  OutboxAggregateState,
  OutboxDiagnostics,
  OutboxEvent,
  OutboxItem,
  OutboxSubscriber,
  Unsubscribe,
} from "./types"

interface SubmitPayload {
  text: string
  attachments?: AttachmentRef[]
}

export interface DraftOutbox {
  // ── Signals IN ──
  userTyped(text: string): void
  userSubmitted(payload: SubmitPayload): string // returns messageId (= the message's id end-to-end)
  userDiscardedDraft(): void
  /**
   * Put text back into the draft from a non-composer source (e.g. the runtime
   * after a failed send). Persists durably AND fires `draftRestored` so the
   * live composer textarea can re-display it — userTyped() alone only writes
   * to storage and would leave the UI empty until next mount.
   */
  restoreDraft(text: string): void
  connectionChanged(state: ConnState): void
  serverAcked(messageId: string): void
  serverRejected(messageId: string, reason: string): void
  transportFailed(messageId: string, reason: string): void
  retry(messageId: string): void
  discardOutboxItem(messageId: string): void

  // ── Read state (for views; mutate only via signals) ──
  getDraft(): string
  getOutbox(): readonly OutboxItem[]
  getConnState(): ConnState
  getAggregate(): OutboxAggregateState
  diagnostics(): OutboxDiagnostics

  // ── Subscriptions ──
  subscribe(handler: OutboxSubscriber): Unsubscribe

  // ── Lifecycle ──
  unmount(): void
}

interface CreateOptions {
  sessionId: string
  /** Initial connection state; default "closed" to be conservative. */
  initialConnState?: ConnState
  /** Optional override of UUID generator (tests). */
  uuid?: () => string
}

/**
 * Create a DraftOutbox for a session. The constructor synchronously runs
 * mountSession: loads draft + outbox from storage, emits draftRestored,
 * and (if a non-empty draft was loaded) holds it ready for the composer.
 */
export function createDraftOutbox(opts: CreateOptions): DraftOutbox {
  initStorage()

  const sessionId = opts.sessionId
  const uuid = opts.uuid ?? generateUUID

  let draft: string = loadDraft(sessionId)
  let outbox: OutboxItem[] = loadOutbox(sessionId)
  let connState: ConnState = opts.initialConnState ?? "closed"

  const subscribers = new Set<OutboxSubscriber>()
  const diag: OutboxDiagnostics = {
    drafts: { persisted: 0, restored: 0, cleared: 0 },
    outbox: { enqueued: 0, acked: 0, failed: 0, requeued: 0 },
    signalsIn: {},
    signalsOut: {},
  }

  // ── helpers ──────────────────────────────────────────────────────────

  function tickIn(name: string): void {
    diag.signalsIn[name] = (diag.signalsIn[name] ?? 0) + 1
  }

  function emit(event: OutboxEvent): void {
    diag.signalsOut[event.type] = (diag.signalsOut[event.type] ?? 0) + 1
    for (const s of subscribers) {
      try {
        s(event)
      } catch (err) {
        logger.error("subscriber threw", {
          eventType: event.type,
          err: String(err),
        })
      }
    }
  }

  function emitAggregate(): void {
    emit({ type: "outboxStateChanged", state: aggregate() })
  }

  function aggregate(): OutboxAggregateState {
    let pending = 0,
      inflight = 0,
      failed = 0
    for (const item of outbox) {
      if (item.state === "pending") pending++
      else if (item.state === "inflight") inflight++
      else if (item.state === "failed") failed++
    }
    return { sessionId, pending, inflight, failed, total: outbox.length }
  }

  function persistOutbox(): void {
    saveOutbox(sessionId, outbox)
  }

  function findItem(messageId: string): OutboxItem | undefined {
    return outbox.find((it) => it.messageId === messageId)
  }

  function flushPending(): void {
    if (connState !== "open") return
    let touched = false
    for (const item of outbox) {
      if (item.state !== "pending") continue
      item.state = "inflight"
      item.attempts += 1
      logger.info("flushItem", {
        sessionId,
        messageId: item.messageId,
        attempt: item.attempts,
      })
      emit({ type: "flushItem", item: { ...item } })
      touched = true
    }
    if (touched) {
      persistOutbox()
      emitAggregate()
    }
  }

  // ── Initial mount ────────────────────────────────────────────────────

  logger.info("mountSession", {
    sessionId,
    "draft.len": draft.length,
    "outbox.len": outbox.length,
  })
  // Defer the initial emits to microtask: subscribers register synchronously
  // after the constructor returns, so emitting now would be lost.
  queueMicrotask(() => {
    if (draft) {
      diag.drafts.restored += 1
      emit({ type: "draftRestored", sessionId, text: draft })
    }
    emitAggregate()
  })

  // ── Public API ───────────────────────────────────────────────────────

  return {
    userTyped(text: string): void {
      tickIn("userTyped")
      // Same value? skip the write — saves localStorage churn during paste.
      if (text === draft) return
      draft = text
      saveDraft(sessionId, text)
      diag.drafts.persisted += 1
      logger.info("userTyped", { sessionId, "text.len": text.length })
    },

    userSubmitted(payload: SubmitPayload): string {
      tickIn("userSubmitted")
      const text = payload.text
      const messageId = uuid()
      const item: OutboxItem = {
        messageId,
        sessionId,
        text,
        attachments: payload.attachments ?? [],
        createdAt: Date.now(),
        state: "pending",
        attempts: 0,
      }
      // Move draft → outbox. CRITICAL: enqueue + clearDraft are both
      // synchronous so I1/I2 hold across the transition.
      outbox = [...outbox, item]
      persistOutbox()
      draft = ""
      clearDraft(sessionId)
      diag.outbox.enqueued += 1
      diag.drafts.cleared += 1
      logger.info("userSubmitted", {
        sessionId,
        messageId,
        "outbox.len": outbox.length,
      })
      emit({ type: "draftCleared", sessionId })
      emitAggregate()
      // Try to send immediately if connected.
      if (connState === "open") flushPending()
      return messageId
    },

    userDiscardedDraft(): void {
      tickIn("userDiscardedDraft")
      if (draft.length === 0) return
      draft = ""
      clearDraft(sessionId)
      diag.drafts.cleared += 1
      logger.info("userDiscardedDraft", { sessionId })
      emit({ type: "draftCleared", sessionId })
    },

    restoreDraft(text: string): void {
      tickIn("restoreDraft")
      // Same value? skip the write — but still emit so the composer
      // textarea (which can be out of sync with outbox.draft) gets the
      // chance to re-display it.
      if (text !== draft) {
        draft = text
        if (text) saveDraft(sessionId, text)
        else clearDraft(sessionId)
        diag.drafts.persisted += 1
      }
      logger.info("restoreDraft", { sessionId, "text.len": text.length })
      emit({ type: "draftRestored", sessionId, text })
    },

    connectionChanged(state: ConnState): void {
      tickIn("connectionChanged")
      // Idempotent: callers (e.g. effects keyed off both `connected` and a
      // memoized outbox handle) may invoke this with the same state on every
      // render. Emitting on no-ops would re-fire outboxStateChanged → new
      // aggregate ref → new memo result → effect re-runs → infinite loop.
      if (state === connState) return
      const prev = connState
      connState = state
      logger.info("connectionChanged", { sessionId, prev, state })
      if (state === "open") {
        flushPending()
      } else if (state === "closed" || state === "reconnecting") {
        // Revert anything that was inflight: we don't know if the bytes
        // landed. Server-side messageId dedup makes a re-send safe.
        let touched = false
        for (const item of outbox) {
          if (item.state === "inflight") {
            item.state = "pending"
            diag.outbox.requeued += 1
            touched = true
          }
        }
        if (touched) {
          persistOutbox()
          emitAggregate()
        }
      }
    },

    serverAcked(messageId: string): void {
      tickIn("serverAcked")
      const before = outbox.length
      outbox = outbox.filter((it) => it.messageId !== messageId)
      if (outbox.length === before) {
        // No matching item — could be a duplicate ack, or an ack for a
        // session this instance doesn't own. Log + ignore.
        logger.warn("serverAcked but no matching item", { sessionId, messageId })
        return
      }
      persistOutbox()
      diag.outbox.acked += 1
      logger.info("serverAcked", {
        sessionId,
        messageId,
        "outbox.len": outbox.length,
      })
      emitAggregate()
    },

    serverRejected(messageId: string, reason: string): void {
      tickIn("serverRejected")
      const item = findItem(messageId)
      if (!item) {
        logger.warn("serverRejected but no matching item", {
          sessionId,
          messageId,
        })
        return
      }
      item.state = "failed"
      item.lastError = reason
      persistOutbox()
      diag.outbox.failed += 1
      logger.error("serverRejected", { sessionId, messageId, reason })
      emit({ type: "itemFailed", messageId, reason, retryable: true })
      emitAggregate()
    },

    transportFailed(messageId: string, reason: string): void {
      tickIn("transportFailed")
      const item = findItem(messageId)
      if (!item) {
        logger.warn("transportFailed but no matching item", {
          sessionId,
          messageId,
        })
        return
      }
      // Transport-level failure is retryable: revert to pending.
      item.state = "pending"
      item.lastError = reason
      persistOutbox()
      diag.outbox.requeued += 1
      logger.warn("transportFailed", { sessionId, messageId, reason })
      emitAggregate()
    },

    retry(messageId: string): void {
      tickIn("retry")
      const item = findItem(messageId)
      if (!item) return
      item.state = "pending"
      item.lastError = undefined
      persistOutbox()
      logger.info("retry", { sessionId, messageId })
      emitAggregate()
      if (connState === "open") flushPending()
    },

    discardOutboxItem(messageId: string): void {
      tickIn("discardOutboxItem")
      const before = outbox.length
      outbox = outbox.filter((it) => it.messageId !== messageId)
      if (outbox.length === before) return
      persistOutbox()
      logger.info("discardOutboxItem", {
        sessionId,
        messageId,
        "outbox.len": outbox.length,
      })
      emitAggregate()
    },

    getDraft(): string {
      return draft
    },
    getOutbox(): readonly OutboxItem[] {
      return outbox
    },
    getConnState(): ConnState {
      return connState
    },
    getAggregate(): OutboxAggregateState {
      return aggregate()
    },
    diagnostics(): OutboxDiagnostics {
      // Return a shallow clone so callers can't mutate counters.
      return {
        drafts: { ...diag.drafts },
        outbox: { ...diag.outbox },
        signalsIn: { ...diag.signalsIn },
        signalsOut: { ...diag.signalsOut },
      }
    },

    subscribe(handler: OutboxSubscriber): Unsubscribe {
      subscribers.add(handler)
      return () => subscribers.delete(handler)
    },

    unmount(): void {
      logger.info("unmountSession", {
        sessionId,
        "draft.len": draft.length,
        "outbox.len": outbox.length,
      })
      subscribers.clear()
    },
  }
}
