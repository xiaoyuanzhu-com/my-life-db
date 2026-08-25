/**
 * draft-outbox — React hook.
 *
 * Connects component lifecycle to a DraftOutbox instance and returns an
 * **identity-stable** API that the composer / runtime / WS-hook layers call.
 *
 * Deliberately holds NO React state. See "Why no React state" below and
 * DESIGN.md § Update loops — this hook lives at the top of the /agent route,
 * so any state it holds re-renders the entire page, and the draft changes on
 * every keystroke.
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { probe } from "~/lib/diagnostics/update-probe"
import { createDraftOutbox, type DraftOutbox } from "./outbox"
import { initStorage, loadDraft, loadOutbox, saveDraft } from "./storage"
import type {
  AttachmentRef,
  ConnState,
  OutboxAggregateState,
  OutboxEvent,
  OutboxItem,
} from "./types"

/**
 * The outbox surface. Every member is a `useCallback([])`, so this object's
 * identity is STABLE for the lifetime of the hook — it survives draft edits,
 * outbox mutations, connection changes and `sessionId` swaps alike.
 *
 * **Why no React state (this is load-bearing):**
 *
 * `useDraftOutbox` is called at the top of the /agent route. Draft text
 * changes on every keystroke, so holding it in React state re-rendered the
 * whole page — AgentPage → ChatRuntimeShell → the runtime adapter → the
 * thread and every message in it — once per character. And the write came
 * from a passive effect (DraftPersistenceSync), so each of those commits
 * ended with another update already pending.
 *
 * React counts exactly that: at the end of every commit that leaves a
 * sync/input-continuous lane pending, `nestedUpdateCount++`; the counter only
 * resets on a commit that drains cleanly. Fifty in a row and React throws
 * error #185 "Maximum update depth exceeded", taking out the whole route.
 * Ordinary typing drains between characters. **iOS voice dictation does
 * not** — it delivers input faster than the two-commit-per-character chain
 * settles, so the counter climbs monotonically to the limit.
 *
 * Nothing rendered `draft` / `outbox` / `aggregate` / `connState` anyway, so
 * they are exposed as getters instead. If a future consumer needs to *render*
 * one of these, do not add state here — subscribe locally (e.g. a
 * `useSyncExternalStore` in the badge component itself) so the re-render is
 * scoped to that component instead of the entire route.
 */
export interface DraftOutboxActions {
  // ── Snapshot reads (pull, not push — see the note above) ──
  /** Current draft text for the active session. */
  getDraft: () => string
  /** Outbox snapshot, ordered by createdAt asc. */
  getOutbox: () => readonly OutboxItem[]
  /** Aggregate counts for badges/banners. */
  getAggregate: () => OutboxAggregateState
  /** Last seen connection state. */
  getConnState: () => ConnState

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

export interface UseDraftOutboxResult extends DraftOutboxActions {
  /**
   * Self-reference, kept so existing `outbox.actions.foo()` call sites keep
   * working. The handle and `.actions` are the same stable object now — the
   * split existed only to give consumers something safe to put in a dep
   * array, and the handle itself is safe.
   */
  actions: DraftOutboxActions
}

/** Count outbox items by state — used by the aggregate fallback. */
function aggregateOf(
  sessionId: string,
  items: readonly OutboxItem[],
): OutboxAggregateState {
  let pending = 0,
    inflight = 0,
    failed = 0
  for (const it of items) {
    if (it.state === "pending") pending++
    else if (it.state === "inflight") inflight++
    else if (it.state === "failed") failed++
  }
  return { sessionId, pending, inflight, failed, total: items.length }
}

/**
 * Mounts a DraftOutbox for the given sessionId. The instance is recreated
 * when sessionId changes (each session has its own draft + outbox).
 */
export function useDraftOutbox(sessionId: string): UseDraftOutboxResult {
  // Box the outbox in a ref so callbacks have a stable identity even though
  // the instance is recreated on sessionId change.
  const outboxRef = useRef<DraftOutbox | null>(null)

  // The session the *current* instance belongs to. Between a sessionId change
  // and the effect below swapping instances, `outboxRef` still points at the
  // previous session's outbox — the getters must not answer from it, or a
  // session switch restores the old session's draft into the new composer.
  const instanceSessionRef = useRef<string | null>(null)

  // Latest sessionId, readable from the stable callbacks (which close over
  // nothing render-scoped by design).
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  // initStorage() is idempotent, but only needs to happen before the first
  // storage read; do it once per hook instance, during the first render, so
  // an early `getDraft()` (child effects run before ours) sees a migrated
  // namespace.
  const storageReadyRef = useRef(false)
  if (!storageReadyRef.current) {
    storageReadyRef.current = true
    initStorage()
  }

  /** The live instance, or null if it isn't for the current session yet. */
  const currentInstance = useCallback((): DraftOutbox | null => {
    if (instanceSessionRef.current !== sessionIdRef.current) return null
    return outboxRef.current
  }, [])

  // Reads fall back to storage when the instance isn't ready — on first mount
  // (child effects run before parent effects, so DraftPersistenceSync's
  // restore runs before our create effect) and in the render right after a
  // session switch.
  const getDraft = useCallback(
    (): string => currentInstance()?.getDraft() ?? loadDraft(sessionIdRef.current),
    [currentInstance],
  )

  const getOutbox = useCallback(
    (): readonly OutboxItem[] =>
      currentInstance()?.getOutbox() ?? loadOutbox(sessionIdRef.current),
    [currentInstance],
  )

  const getAggregate = useCallback((): OutboxAggregateState => {
    const ob = currentInstance()
    if (ob) return ob.getAggregate()
    const sid = sessionIdRef.current
    return aggregateOf(sid, loadOutbox(sid))
  }, [currentInstance])

  const getConnState = useCallback(
    (): ConnState => currentInstance()?.getConnState() ?? "closed",
    [currentInstance],
  )

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
    instanceSessionRef.current = sessionId

    const unsub = ob.subscribe((event: OutboxEvent) => {
      switch (event.type) {
        case "draftRestored":
          for (const h of restoreSubsRef.current) h(event.text)
          break
        case "draftCleared":
          // Nothing to mirror: the composer clears itself on submit, and
          // `getDraft()` reads straight through to the instance.
          break
        case "outboxStateChanged":
          // Pull-only: consumers read `getAggregate()` / `getOutbox()` when
          // they need a snapshot. Pushing this into React state here would
          // re-render the whole /agent route (see DraftOutboxActions).
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
      instanceSessionRef.current = null
    }
  }, [sessionId])

  // ── Stable callbacks ────────────────────────────────────────────────

  // Hot path: called once per character while the user types or dictates.
  // Plain JS + a localStorage write, no React state — see DraftOutboxActions
  // for why this must never schedule a render.
  const setDraft = useCallback(
    (text: string) => {
      probe("draft-outbox.setDraft")
      const ob = currentInstance()
      if (ob) {
        ob.userTyped(text)
        return
      }
      // No instance yet (first mount, or mid session-swap): persist directly
      // so text typed in that window isn't dropped. `getDraft()` reads the
      // same key, so the value is visible immediately.
      saveDraft(sessionIdRef.current, text)
    },
    [currentInstance],
  )

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
  }, [])

  const notifyConnection = useCallback((state: ConnState) => {
    // Idempotent — callers re-invoke with the same state whenever their
    // effect re-runs; `connectionChanged` early-returns on no change.
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

  // Every dep below is a `useCallback([])`, so this memo is computed once and
  // keeps its identity for the hook's lifetime — including across sessionId
  // changes (the subscriber Sets and `outboxRef` it closes over are refs that
  // survive the instance swap). Safe to put in any dep array.
  const actions = useMemo<DraftOutboxActions>(
    () => ({
      getDraft,
      getOutbox,
      getAggregate,
      getConnState,
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
      getDraft,
      getOutbox,
      getAggregate,
      getConnState,
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

  // Identity-stable for the hook's lifetime. Consumers may hold this in memo
  // deps, effect deps and context values without churning them.
  return useMemo(() => ({ ...actions, actions }), [actions])
}
