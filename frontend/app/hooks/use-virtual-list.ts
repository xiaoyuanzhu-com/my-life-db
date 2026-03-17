import { useCallback, useLayoutEffect, useRef, useState } from 'react'

// ============================================================================
// Types
// ============================================================================

interface VirtualListOptions {
  /** Total number of items */
  count: number
  /** Estimated height per item in pixels */
  estimateSize: number
  /** Extra pixels to render above/below the visible range */
  overscanPx: number
  /** Ref to the scroll container element */
  scrollElement: React.RefObject<HTMLDivElement | null>
  /** Ref to the inner content wrapper (child of scrollElement). When provided,
   *  a ResizeObserver on this element reapplies the scrollBottom anchor after
   *  newly-rendered items settle to their real heights (fixes Safari drift). */
  contentElement?: React.RefObject<HTMLDivElement | null>
  /** Stable function returning a unique key for the given index */
  getKey: (index: number) => string | number
  /** Whether the list should initialize from the bottom (stick-to-bottom) */
  shouldStick: React.RefObject<boolean>
  /** Whether user scroll intent is active (freeze range updates during momentum scroll) */
  userScrollIntent?: React.RefObject<boolean>
}

interface VirtualListRange {
  startIndex: number
  endIndex: number // exclusive
  topHeight: number // px for top spacer div
  bottomHeight: number // px for bottom spacer div
}

// ============================================================================
// Pure range calculation
// ============================================================================

function calcRange(
  scrollTop: number,
  viewportHeight: number,
  count: number,
  estimateSize: number,
  overscan: number,
): { startIndex: number; endIndex: number } {
  if (count === 0) return { startIndex: 0, endIndex: 0 }
  // Clamp rawStart to valid range — actual content height can exceed
  // count * estimateSize when items are taller than the estimate,
  // which would push rawStart beyond count and produce an empty range.
  const rawStart = Math.min(Math.floor(scrollTop / estimateSize), count - 1)
  const visibleCount = Math.ceil(viewportHeight / estimateSize)
  const startIndex = Math.max(0, rawStart - overscan)
  const endIndex = Math.min(count, rawStart + visibleCount + overscan)
  return { startIndex, endIndex }
}

// ============================================================================
// Hook
// ============================================================================

/**
 * useVirtualList — flow-based virtual list for chat message rendering.
 *
 * Controls only WHICH items are in the DOM. Items render in normal document
 * flow (no absolute positioning). Spacer divs above and below approximate
 * the height of off-screen items.
 *
 * Scroll position management is deliberately excluded — the browser's native
 * scroll anchoring (`overflow-anchor: auto` on the container) handles visual
 * stability when items resize, and the `useScrollController` hook handles
 * stick-to-bottom, hide-on-scroll, and history paging.
 *
 * Prepend detection is done during render (not in an effect) so that React
 * discards the interrupted render and re-renders with the shifted range
 * atomically. This prevents an intermediate DOM state where items have wrong
 * keys, which would break browser scroll anchoring.
 *
 * This hook NEVER touches scrollTop.
 */
export function useVirtualList(options: VirtualListOptions): VirtualListRange {
  const { count, estimateSize, overscanPx, scrollElement, contentElement, getKey, shouldStick, userScrollIntent } = options
  const overscan = Math.ceil(overscanPx / estimateSize)

  // Stable ref for getKey — prevents the count-change effect from firing
  // on every filteredMessages change. getKey's identity changes whenever
  // filteredMessages gets a new reference (every messages prop update),
  // but the count-change effect only needs to run when count changes.
  // The ref gives the effect body access to the latest getKey without
  // adding it to the dependency array.
  const getKeyRef = useRef(getKey)
  getKeyRef.current = getKey

  // ---- State: visible range ----
  const [range, setRange] = useState<{ startIndex: number; endIndex: number }>(() => {
    if (count === 0) return { startIndex: 0, endIndex: 0 }

    // If should stick, initialize from bottom so first render shows the end
    if (shouldStick.current) {
      const viewportHeight = scrollElement.current?.clientHeight ?? 800
      const visibleCount = Math.ceil(viewportHeight / estimateSize)
      const startIndex = Math.max(0, count - visibleCount - overscan)
      return { startIndex, endIndex: count }
    }

    const viewportHeight = scrollElement.current?.clientHeight ?? 800
    const visibleCount = Math.ceil(viewportHeight / estimateSize)
    return { startIndex: 0, endIndex: Math.min(count, visibleCount + overscan) }
  })

  // ---- Prepend tracking ----
  const prevFirstKeyRef = useRef<string | number | undefined>(
    count > 0 ? getKey(0) : undefined,
  )
  const prependSnapshotRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const prependHandledRef = useRef(false)

  // ---- Manual scroll anchoring ----
  // Safari lacks overflow-anchor, so when items above the viewport are added/removed
  // (startIndex changes), the spacer↔item height mismatch causes a visual jump.
  //
  // Two-layer anchor system:
  //
  // 1. Primary anchor (anchorRef): scrollBottom-based, one-shot.
  //    Captures scrollBottom before a range change that moves startIndex.
  //    Applied in useLayoutEffect immediately after React commits the DOM change.
  //    Cleared after use.
  //
  // 2. Persistent anchor (persistentAnchorRef): element-based, survives past layout effect.
  //    After the primary anchor fires, captures a visible DOM element's viewport offset.
  //    The content ResizeObserver reapplies it as newly-rendered items settle to their
  //    real heights (fixes Safari drift from spacer→item height mismatches).
  //
  //    Element-based (not scrollBottom-based) because it must be immune to content
  //    changes BELOW the viewport. scrollBottom changes when streaming content grows
  //    at the bottom, causing the anchor to fight those changes and push the user's
  //    view. An element's viewport offset only changes when content ABOVE it changes —
  //    exactly the settling behavior we need to compensate for.
  //
  //    This is the same approach browser overflow-anchor uses natively.
  //
  // Cleared when the user scrolls (they take control of scroll position).
  const anchorRef = useRef<{ scrollBottom: number } | null>(null)
  const persistentAnchorRef = useRef<{ vi: string; offset: number } | null>(null)

  // iOS Safari fires scroll events asynchronously for programmatic scrollTop
  // assignments. These deferred events would clear persistentAnchorRef before
  // the content ResizeObserver can use it. This flag suppresses the clear for
  // scroll events that originate from our own scrollTop assignments.
  // Reset to false on scrollend (by which point all deferred events have fired).
  const programmaticScrollRef = useRef(false)

  // ---- Render-phase prepend detection ----
  // Detecting prepends during render and calling setRange immediately makes React
  // discard the interrupted render and retry with the corrected range. The DOM
  // never sees the intermediate state (new count, old range) where items would
  // have different keys.
  //
  // We also snapshot scrollHeight/scrollTop BEFORE the DOM changes. After React
  // commits the shifted range, a layout effect restores the scroll position using
  // the height delta — this is a manual scroll anchor that doesn't depend on
  // browser overflow-anchor behavior.
  if (count > 0 && prevFirstKeyRef.current !== undefined) {
    const currentFirstKey = getKey(0)
    if (currentFirstKey !== prevFirstKeyRef.current) {
      let prependCount = 0
      for (let i = 0; i < count; i++) {
        if (getKey(i) === prevFirstKeyRef.current) {
          prependCount = i
          break
        }
      }
      if (prependCount > 0) {
        const newStart = Math.min(range.startIndex + prependCount, count - 1)
        const newEnd = Math.min(range.endIndex + prependCount, count)
        if (newStart !== range.startIndex || newEnd !== range.endIndex) {
          // Snapshot scroll state from the current (old) DOM before React re-renders
          const el = scrollElement.current
          if (el) {
            prependSnapshotRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
          }
          prependHandledRef.current = true
          setRange({ startIndex: newStart, endIndex: newEnd })
        }
      }
      // Update ref regardless of whether it was a prepend (handles replacements too)
      prevFirstKeyRef.current = currentFirstKey
    }
  }

  // ---- Range update (called from scroll listener and effects) ----

  // Capture a visible DOM element as a persistent anchor for Safari drift
  // compensation. The element nearest the viewport center is chosen because
  // it's most likely to remain in the DOM across range changes.
  //
  // Each rendered item has a data-vi attribute (virtual index), so the anchor
  // lookup is a single querySelector.
  const captureElementAnchor = useCallback(() => {
    const el = scrollElement.current
    if (!el) return
    const containerRect = el.getBoundingClientRect()
    const viewportCenterY = containerRect.top + el.clientHeight / 2
    const items = el.querySelectorAll('[data-vi]')
    let best: Element | null = null
    let bestDist = Infinity
    for (const item of items) {
      const rect = item.getBoundingClientRect()
      const center = rect.top + rect.height / 2
      const dist = Math.abs(center - viewportCenterY)
      if (dist < bestDist) {
        bestDist = dist
        best = item
      }
    }
    if (best) {
      const vi = best.getAttribute('data-vi')
      if (vi) {
        persistentAnchorRef.current = {
          vi,
          offset: best.getBoundingClientRect().top - containerRect.top,
        }
      }
    }
  }, [scrollElement])

  // Capture scrollBottom before range changes that move startIndex.
  // Since we never change both ends simultaneously, content below the
  // viewport is unchanged and scrollBottom is invariant.
  const captureScrollBottom = useCallback(() => {
    const el = scrollElement.current
    if (!el) return
    const scrollBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    anchorRef.current = { scrollBottom }
  }, [scrollElement])

  const updateRange = useCallback(() => {
    const el = scrollElement.current
    if (!el || count === 0) return

    const next = calcRange(el.scrollTop, el.clientHeight, count, estimateSize, overscan)
    const scrolling = userScrollIntent?.current

    setRange((prev) => {
      if (prev.startIndex === next.startIndex && prev.endIndex === next.endIndex) return prev

      if (scrolling) {
        // During user scroll: freeze range to avoid jitter (Safari lacks
        // overflow-anchor). But if the visible viewport is approaching the
        // edge of the rendered buffer, expand to prevent blank space.
        const viewportTop = el.scrollTop
        const viewportBottom = viewportTop + el.clientHeight
        const renderedTop = prev.startIndex * estimateSize
        const renderedBottom = prev.endIndex * estimateSize
        const edgePx = 1080

        // Only check edges where there's actually a spacer (more items to render).
        // When all items are rendered on one side, there's no blank space danger.
        const nearTopEdge = prev.startIndex > 0 && viewportTop < renderedTop + edgePx
        const nearBottomEdge = prev.endIndex < count && viewportBottom > renderedBottom - edgePx

        if (!nearTopEdge && !nearBottomEdge) {
          return prev
        }

        // Near edge — expand-only (never shrink) to prevent blank space
        const startIndex = Math.min(prev.startIndex, next.startIndex)
        const endIndex = Math.max(prev.endIndex, next.endIndex)
        if (startIndex === prev.startIndex && endIndex === prev.endIndex) return prev
        // Capture anchor before DOM changes (edge expand during scroll)
        // Edge expand only adds items (never removes), so only one end changes
        if (startIndex !== prev.startIndex) captureScrollBottom()
        return { startIndex, endIndex }
      }

      // When idle: expand and shrink one side at a time, never both.
      // This guarantees scrollBottom (or scrollTop) is invariant, so
      // scroll anchoring is always exact with no drift.
      //
      // Priority: expand first (prevents blank space), shrink later.
      const wantStart = Math.max(
        Math.min(prev.startIndex, next.startIndex),
        next.startIndex - overscan,
      )
      const wantEnd = Math.min(
        Math.max(prev.endIndex, next.endIndex),
        next.endIndex + overscan,
      )

      // Expand: add items on whichever side needs it
      if (wantStart < prev.startIndex) {
        captureScrollBottom()
        return { startIndex: wantStart, endIndex: prev.endIndex }
      }
      if (wantEnd > prev.endIndex) {
        return { startIndex: prev.startIndex, endIndex: wantEnd }
      }

      // Shrink: remove items from the far side (lower priority)
      if (wantStart > prev.startIndex) {
        return { startIndex: wantStart, endIndex: prev.endIndex }
      }
      if (wantEnd < prev.endIndex) {
        return { startIndex: prev.startIndex, endIndex: wantEnd }
      }

      return prev
    })
  }, [scrollElement, count, estimateSize, overscan, userScrollIntent, captureScrollBottom])

  // ---- Scroll listener (passive) ----
  // Also listen for scrollend to update range after momentum scroll ends
  // (range updates are frozen during userScrollIntent).
  useLayoutEffect(() => {
    const el = scrollElement.current
    if (!el) return
    const handleScroll = () => {
      // Don't clear persistentAnchorRef for programmatic scrollTop assignments.
      // iOS Safari fires scroll events asynchronously for those, so they arrive
      // after our layout effect has set persistentAnchorRef — wiping it before
      // the content ResizeObserver can compensate for item resize drift.
      //
      // Also skip updateRange for programmatic scroll events entirely. Each
      // expand-top anchor adjusts scrollTop, which fires a deferred scroll event
      // on iOS. That scroll triggers updateRange → another expand → another anchor,
      // creating a visible multi-jump feedback loop at momentum end. The range is
      // close enough after one expand (overscan provides a large buffer), and
      // scrollend will call updateRange after all anchoring settles.
      if (!programmaticScrollRef.current) {
        persistentAnchorRef.current = null
        updateRange()
      }
    }
    const handleScrollEnd = () => {
      // By scrollend, all deferred scroll events from programmatic sets have fired.
      // If this scrollend came from an anchor adjustment (programmatic), skip
      // updateRange — it would start another expand cycle. The next real user
      // scroll or viewport resize will update the range.
      const wasProgrammatic = programmaticScrollRef.current
      programmaticScrollRef.current = false
      if (!wasProgrammatic) {
        updateRange()
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    el.addEventListener('scrollend', handleScrollEnd, { passive: true })
    return () => {
      el.removeEventListener('scroll', handleScroll)
      el.removeEventListener('scrollend', handleScrollEnd)
    }
  }, [scrollElement, updateRange])

  // ---- Viewport resize ----
  useLayoutEffect(() => {
    const el = scrollElement.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => updateRange())
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollElement, updateRange])

  // ---- Content resize anchor compensation (Safari overflow-anchor workaround) ----
  // After an expand-top, newly-rendered items settle to their real heights via
  // ResizeObserver. Each resize changes scrollHeight without adjusting scrollTop
  // on Safari (no overflow-anchor).
  //
  // Uses element-based anchoring: finds the anchor element by data-vi attribute,
  // measures how far it drifted from its captured offset, and adjusts scrollTop
  // by the drift. This is immune to content changes BELOW the anchor element
  // (streaming, new messages) because those don't affect the anchor's position.
  useLayoutEffect(() => {
    const content = contentElement?.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const pa = persistentAnchorRef.current
      if (!pa || userScrollIntent?.current) return
      const el = scrollElement.current
      if (!el) return
      // Find the anchor element by virtual index
      const item = el.querySelector(`[data-vi="${pa.vi}"]`)
      if (!item) {
        // Element was unmounted (range changed beyond it) — clear anchor
        persistentAnchorRef.current = null
        return
      }
      const containerRect = el.getBoundingClientRect()
      const currentOffset = item.getBoundingClientRect().top - containerRect.top
      const drift = currentOffset - pa.offset
      if (Math.abs(drift) > 2) {
        programmaticScrollRef.current = true
        el.scrollTop += drift
        // offset target stays the same — we're restoring the element to its
        // original position, so pa.offset remains the correct target
      }
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [contentElement, scrollElement, userScrollIntent])

  // ---- Count changes: non-prepend adjustments (append, filter, initial load) ----
  // Prepend is already handled in render phase above. This effect handles the rest.
  //
  // Uses getKeyRef (not getKey) to avoid firing on every filteredMessages change.
  // getKey's identity changes whenever filteredMessages gets a new reference,
  // but this effect only needs to run when count changes. The ref gives the
  // effect body access to the latest getKey without triggering re-execution.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    // Skip if render-phase prepend detection already adjusted the range.
    // The count-change effect would otherwise override the shifted range with
    // a stale calculation, causing a visual jump.
    if (prependHandledRef.current) {
      prependHandledRef.current = false
      prevFirstKeyRef.current = count > 0 ? getKeyRef.current(0) : undefined
      return
    }

    if (count === 0) {
      setRange({ startIndex: 0, endIndex: 0 })
      prevFirstKeyRef.current = undefined
      return
    }

    // Non-prepend count change (append, filter change, initial load)
    if (shouldStick.current) {
      // At bottom: extend range to include new items
      const viewportHeight = scrollElement.current?.clientHeight ?? 800
      const visibleCount = Math.ceil(viewportHeight / estimateSize)
      const nextRange = {
        startIndex: Math.max(0, count - visibleCount - overscan),
        endIndex: count,
      }
      setRange(nextRange)
    } else {
      // Not at bottom: keep start position, extend end if needed
      setRange((prev) => {
        const viewportHeight = scrollElement.current?.clientHeight ?? 800
        const visibleCount = Math.ceil(viewportHeight / estimateSize)
        const endIndex = Math.min(count, prev.startIndex + visibleCount + 2 * overscan)
        if (prev.endIndex === endIndex) return prev
        return { startIndex: prev.startIndex, endIndex }
      })
    }

    prevFirstKeyRef.current = count > 0 ? getKeyRef.current(0) : undefined
  }, [count, shouldStick, scrollElement, estimateSize, overscan])

  // ---- Scroll anchoring (prepend + range changes) ----
  // After React commits DOM changes, restore scroll position using an anchor
  // element's viewport offset. This is a manual implementation of overflow-anchor
  // for Safari which lacks native support.
  // Handles both prepend (count change) and range changes (startIndex moves).
  // During momentum scroll, skip — setting scrollTop kills momentum.
  useLayoutEffect(() => {
    // Prepend snapshot uses height-delta approach (items are new, no anchor element)
    const prependSnap = prependSnapshotRef.current
    if (prependSnap) {
      prependSnapshotRef.current = null
      const el = scrollElement.current
      if (!el) return
      const heightAdded = el.scrollHeight - prependSnap.scrollHeight
      if (heightAdded === 0) return
      if (userScrollIntent?.current) {
        return
      }
      const expectedScrollTop = prependSnap.scrollTop + heightAdded
      if (Math.abs(el.scrollTop - expectedScrollTop) > 2) {
        programmaticScrollRef.current = true
        el.scrollTop = expectedScrollTop
      }
      anchorRef.current = null // clear any stale anchor
      return
    }

    // Restore scroll position for range changes (startIndex moved).
    // scrollBottom is invariant because we only change one end at a time.
    const anchor = anchorRef.current
    if (!anchor) return
    anchorRef.current = null
    const el = scrollElement.current
    if (!el) return
    if (userScrollIntent?.current) {
      return
    }
    const newScrollTop = el.scrollHeight - el.clientHeight - anchor.scrollBottom
    if (Math.abs(el.scrollTop - newScrollTop) > 2) {
      programmaticScrollRef.current = true
      el.scrollTop = newScrollTop
    }
    // After the primary scrollBottom anchor corrects scrollTop, capture a
    // visible element as the persistent anchor. The content ResizeObserver
    // will use this to compensate for items settling to their real heights.
    //
    // Element-based (not scrollBottom) so it's immune to streaming content
    // growing below the viewport — only reacts to changes above the anchor.
    captureElementAnchor()
  }, [range.startIndex, range.endIndex, scrollElement, userScrollIntent, captureElementAnchor])


  // ---- Derived spacer heights ----
  const topHeight = range.startIndex * estimateSize
  const bottomHeight = Math.max(0, (count - range.endIndex) * estimateSize)

  return {
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    topHeight,
    bottomHeight,
  }
}
