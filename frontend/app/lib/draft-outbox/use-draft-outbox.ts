/**
 * draft-outbox — React hook.
 *
 * Connects component lifecycle to a DraftOutbox instance. Returns a
 * stable API the composer/runtime/WS-hook layers can call. State that
 * the UI cares about (draft text, outbox items, aggregate counts) is
 * exposed as React state so renders happen on changes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createDraftOutbox, type DraftOutbox } from "./outbox"
import { initStorage, loadDraft, loadOutbox } from "./storage"
import type {
  AttachmentRef,
  ConnState,
  OutboxAggregateState,
  OutboxEvent,
  OutboxItem,
} from "./types"

export interface UseDraftOutboxResult {
  /** Current draft text. Source of truth for the composer's value. */
  draft: string
  /** Outbox snapshot, ordered by createdAt asc. */
  outbox: readonly OutboxItem[]
  /** Aggregate counts for badges/banners. */
  aggregate: OutboxAggregateState
  /** Last seen connection state. */
  connState: ConnState

  // ── Composer-driven signals ──
  setDraft: (text: string) => void
  submit: (payload: { text: string; attachments?: AttachmentRef[] }) => string
  discardDraft: () => void
  /**
   * Push text back into the draft from a non-composer source (e.g. the
   * runtime catch after a failed POST). Persists durably AND fires the
   * `draftRestored` channel — `subscribeDraftRestored` consumers (the
   * composer bridge) re-display it in the live textarea.
   */
  restoreDraft: (text: string) => void

  // ── Network-driven signals (called from WS hook / onFrame) ──
  notifyConnection: (state: ConnState) => void
  notifyAcked: (messageId: string) => void
  notifyRejected: (messageId: string, reason: string) => void
  notifyTransportFailure: (messageId: string, reason: string) => void

  // ── Outbox UI actions ──
  retry: (messageId: string) => void
  discardOutboxItem: (messageId: string) => void

  /** Subscribe to flushItem events (the WS hook uses this to send). */
  subscribeFlush: (handler: (item: OutboxItem) => void) => () => void

  /** Subscribe to itemFailed events (toast/banner). */
  subscribeItemFailed: (
    handler: (e: { messageId: string; reason: string; retryable: boolean }) => void,
  ) => () => void

  /**
   * Subscribe to `draftRestored` events. The composer bridge uses this to
   * imperatively call `composer.setText(text)` — necessary because the
   * assistant-ui composer maintains its own internal text state and won't
   * pick up outbox-side draft changes through React state alone.
   */
  subscribeDraftRestored: (handler: (text: string) => void) => () => void
}

/**
 * Mounts a DraftOutbox for the given sessionId. The instance is recreated
 * when sessionId changes (each session has its own draft + outbox).
 */
export function useDraftOutbox(sessionId: string): UseDraftOutboxResult {
  // Box the outbox in a ref so callbacks have a stable identity even though
  // the instance is recreated on sessionId change. State below is what the
  // UI reads; we mirror outbox internals into it on every event.
  const outboxRef = useRef<DraftOutbox | null>(null)

  // Lazy init from storage so the very first render of this hook returns the
  // correct draft for `sessionId` — without this, consumers like
  // DraftPersistenceSync read `""` on mount, persist that empty back, and
  // overwrite the saved draft.
  //
  // initStorage() is idempotent and safe to call here; it primes the legacy
  // purge + meta key before the first read.
  const [draft, setDraftState] = useState<string>(() => {
    initStorage()
    return loadDraft(sessionId)
  })
  const [items, setItems] = useState<readonly OutboxItem[]>(() =>
    loadOutbox(sessionId),
  )
  const [aggregate, setAggregate] = useState<OutboxAggregateState>(() => {
    const initial = loadOutbox(sessionId)
    let pending = 0,
      inflight = 0,
      failed = 0
    for (const it of initial) {
      if (it.state === "pending") pending++
      else if (it.state === "inflight") inflight++
      else if (it.state === "failed") failed++
    }
    return { sessionId, pending, inflight, failed, total: initial.length }
  })
  const [connState, setConnState] = useState<ConnState>("closed")

  // Synchronously reset state when sessionId changes — React's "adjust state
  // on prop change" pattern. The useEffect below also runs (and swaps the
  // outbox instance), but its setStates land in the *next* render, which is
  // too late: consumers reading `outbox.draft` during the first render after
  // a session switch would see the previous session's value, restore the
  // composer to it, then the persist effect would write that stale text
  // back into the new session's storage. Doing the reset here makes the
  // first render after a switch already show the correct per-session draft.
  const lastSessionIdRef = useRef(sessionId)
  if (lastSessionIdRef.current !== sessionId) {
    lastSessionIdRef.current = sessionId
    const nextDraft = loadDraft(sessionId)
    const nextItems = loadOutbox(sessionId)
    let pending = 0,
      inflight = 0,
      failed = 0
    for (const it of nextItems) {
      if (it.state === "pending") pending++
      else if (it.state === "inflight") inflight++
      else if (it.state === "failed") failed++
    }
    setDraftState(nextDraft)
    setItems(nextItems)
    setAggregate({
      sessionId,
      pending,
      inflight,
      failed,
      total: nextItems.length,
    })
    setConnState("closed")
  }

  // External subscribers (flush, itemFailed, draftRestored). We multiplex
  // through here so a single outbox subscription serves all consumers and
  // we don't pay the cost of one outbox.subscribe per consumer.
  const flushSubsRef = useRef<Set<(item: OutboxItem) => void>>(new Set())
  const failSubsRef = useRef<
    Set<(e: { messageId: string; reason: string; retryable: boolean }) => void>
  >(new Set())
  const restoreSubsRef = useRef<Set<(text: string) => void>>(new Set())

  useEffect(() => {
    const ob = createDraftOutbox({ sessionId })
    outboxRef.current = ob

    // Initial snapshot.
    setDraftState(ob.getDraft())
    setItems(ob.getOutbox())
    setAggregate(ob.getAggregate())
    setConnState(ob.getConnState())

    const unsub = ob.subscribe((event: OutboxEvent) => {
      switch (event.type) {
        case "draftRestored":
          setDraftState(event.text)
          for (const h of restoreSubsRef.current) h(event.text)
          break
        case "draftCleared":
          setDraftState("")
          break
        case "outboxStateChanged":
          setAggregate(event.state)
          setItems(ob.getOutbox())
          break
        case "flushItem":
          for (const h of flushSubsRef.current) h(event.item)
          break
        case "itemFailed":
          for (const h of failSubsRef.current)
            h({
              messageId: event.messageId,
              reason: event.reason,
              retryable: event.retryable,
            })
          break
        case "log":
          // Already logged inside the module; nothing to do here.
          break
      }
    })

    return () => {
      unsub()
      ob.unmount()
      outboxRef.current = null
    }
  }, [sessionId])

  // ── Stable callbacks ────────────────────────────────────────────────

  const setDraft = useCallback((text: string) => {
    outboxRef.current?.userTyped(text)
    // Echo immediately so controlled-input cursor placement is stable;
    // outbox does the persistence.
    setDraftState(text)
  }, [])

  const submit = useCallback(
    (payload: { text: string; attachments?: AttachmentRef[] }): string => {
      const ob = outboxRef.current
      if (!ob) return ""
      return ob.userSubmitted(payload)
    },
    [],
  )

  const discardDraft = useCallback(() => {
    outboxRef.current?.userDiscardedDraft()
  }, [])

  // Restore the draft from a non-composer source (e.g. runtime catch after
  // a failed POST). Writes to durable storage AND fires `draftRestored`,
  // which DraftPersistenceSync forwards into the live composer textarea —
  // setDraft alone leaves the textarea blank until next mount.
  const restoreDraft = useCallback((text: string) => {
    outboxRef.current?.restoreDraft(text)
    setDraftState(text)
  }, [])

  const notifyConnection = useCallback((state: ConnState) => {
    setConnState(state)
    outboxRef.current?.connectionChanged(state)
  }, [])

  const notifyAcked = useCallback((messageId: string) => {
    outboxRef.current?.serverAcked(messageId)
  }, [])

  const notifyRejected = useCallback((messageId: string, reason: string) => {
    outboxRef.current?.serverRejected(messageId, reason)
  }, [])

  const notifyTransportFailure = useCallback(
    (messageId: string, reason: string) => {
      outboxRef.current?.transportFailed(messageId, reason)
    },
    [],
  )

  const retry = useCallback((messageId: string) => {
    outboxRef.current?.retry(messageId)
  }, [])

  const discardOutboxItem = useCallback((messageId: string) => {
    outboxRef.current?.discardOutboxItem(messageId)
  }, [])

  const subscribeFlush = useCallback(
    (handler: (item: OutboxItem) => void): (() => void) => {
      flushSubsRef.current.add(handler)
      return () => flushSubsRef.current.delete(handler)
    },
    [],
  )

  const subscribeItemFailed = useCallback(
    (
      handler: (e: { messageId: string; reason: string; retryable: boolean }) => void,
    ): (() => void) => {
      failSubsRef.current.add(handler)
      return () => failSubsRef.current.delete(handler)
    },
    [],
  )

  // Subscribe to draftRestored events. Used by DraftPersistenceSync to
  // imperatively push restored text into the assistant-ui composer (whose
  // own internal text state is otherwise unaware of outbox-side restores).
  const subscribeDraftRestored = useCallback(
    (handler: (text: string) => void): (() => void) => {
      restoreSubsRef.current.add(handler)
      return () => restoreSubsRef.current.delete(handler)
    },
    [],
  )

  return useMemo(
    () => ({
      draft,
      outbox: items,
      aggregate,
      connState,
      setDraft,
      submit,
      discardDraft,
      restoreDraft,
      notifyConnection,
      notifyAcked,
      notifyRejected,
      notifyTransportFailure,
      retry,
      discardOutboxItem,
      subscribeFlush,
      subscribeItemFailed,
      subscribeDraftRestored,
    }),
    [
      draft,
      items,
      aggregate,
      connState,
      setDraft,
      submit,
      discardDraft,
      restoreDraft,
      notifyConnection,
      notifyAcked,
      notifyRejected,
      notifyTransportFailure,
      retry,
      discardOutboxItem,
      subscribeFlush,
      subscribeItemFailed,
      subscribeDraftRestored,
    ],
  )
}
