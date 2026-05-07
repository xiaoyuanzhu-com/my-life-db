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

  // ── Network-driven signals (called from WS hook / onFrame) ──
  notifyConnection: (state: ConnState) => void
  notifyAcked: (clientId: string) => void
  notifyRejected: (clientId: string, reason: string) => void
  notifyTransportFailure: (clientId: string, reason: string) => void

  // ── Outbox UI actions ──
  retry: (clientId: string) => void
  discardOutboxItem: (clientId: string) => void

  /** Subscribe to flushItem events (the WS hook uses this to send). */
  subscribeFlush: (handler: (item: OutboxItem) => void) => () => void

  /** Subscribe to itemFailed events (toast/banner). */
  subscribeItemFailed: (
    handler: (e: { clientId: string; reason: string; retryable: boolean }) => void,
  ) => () => void
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

  const [draft, setDraftState] = useState<string>("")
  const [items, setItems] = useState<readonly OutboxItem[]>([])
  const [aggregate, setAggregate] = useState<OutboxAggregateState>({
    sessionId,
    pending: 0,
    inflight: 0,
    failed: 0,
    total: 0,
  })
  const [connState, setConnState] = useState<ConnState>("closed")

  // External subscribers (flush, itemFailed). We multiplex through here so
  // a single outbox subscription serves all consumers and we don't pay the
  // cost of one outbox.subscribe per consumer.
  const flushSubsRef = useRef<Set<(item: OutboxItem) => void>>(new Set())
  const failSubsRef = useRef<
    Set<(e: { clientId: string; reason: string; retryable: boolean }) => void>
  >(new Set())

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
              clientId: event.clientId,
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

  const notifyConnection = useCallback((state: ConnState) => {
    setConnState(state)
    outboxRef.current?.connectionChanged(state)
  }, [])

  const notifyAcked = useCallback((clientId: string) => {
    outboxRef.current?.serverAcked(clientId)
  }, [])

  const notifyRejected = useCallback((clientId: string, reason: string) => {
    outboxRef.current?.serverRejected(clientId, reason)
  }, [])

  const notifyTransportFailure = useCallback(
    (clientId: string, reason: string) => {
      outboxRef.current?.transportFailed(clientId, reason)
    },
    [],
  )

  const retry = useCallback((clientId: string) => {
    outboxRef.current?.retry(clientId)
  }, [])

  const discardOutboxItem = useCallback((clientId: string) => {
    outboxRef.current?.discardOutboxItem(clientId)
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
      handler: (e: { clientId: string; reason: string; retryable: boolean }) => void,
    ): (() => void) => {
      failSubsRef.current.add(handler)
      return () => failSubsRef.current.delete(handler)
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
      notifyConnection,
      notifyAcked,
      notifyRejected,
      notifyTransportFailure,
      retry,
      discardOutboxItem,
      subscribeFlush,
      subscribeItemFailed,
    }),
    [
      draft,
      items,
      aggregate,
      connState,
      setDraft,
      submit,
      discardDraft,
      notifyConnection,
      notifyAcked,
      notifyRejected,
      notifyTransportFailure,
      retry,
      discardOutboxItem,
      subscribeFlush,
      subscribeItemFailed,
    ],
  )
}
