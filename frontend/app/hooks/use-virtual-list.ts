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

  // ---- State: visible range ----
  const [range, setRange] = useState<{ startIndex: number; endIndex: number }>(() => {
    if (count === 0) {
      console.log('[VirtualList] init: count=0')
      return { startIndex: 0, endIndex: 0 }
    }

    // If should stick, initialize from bottom so first render shows the end
    if (shouldStick.current) {
      const viewportHeight = scrollElement.current?.clientHeight ?? 800
      const visibleCount = Math.ceil(viewportHeight / estimateSize)
      const startIndex = Math.max(0, count - visibleCount - overscan)
      console.log('[VirtualList] init from bottom:', {
        count,
        viewportHeight,
        visibleCount,
        startIndex,
        endIndex: count,
        scrollElExists: !!scrollElement.current,
      })
      return { startIndex, endIndex: count }
    }

    const viewportHeight = scrollElement.current?.clientHeight ?? 800
    const visibleCount = Math.ceil(viewportHeight / estimateSize)
    console.log('[VirtualList] init from top:', {
      count,
      viewportHeight,
      visibleCount,
      startIndex: 0,
      endIndex: Math.min(count, visibleCount + overscan),
    })
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
  // Range updates never change both ends simultaneously (expand/shrink one side
  // at a time), so scrollBottom is always invariant when startIndex changes.
  const anchorRef = useRef<{ scrollBottom: number } | null>(null)

  // persistentAnchorRef survives past the layout-effect restore. It's reapplied
  // each time the content ResizeObserver fires (newly-rendered items settling to
  // real heights change scrollHeight without scrollTop compensation on Safari).
  // Cleared when the user scrolls (they take control of scroll position).
  const persistentAnchorRef = useRef<{ scrollBottom: number } | null>(null)

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

  // Capture scrollBottom before range changes that move startIndex.
  // Since we never change both ends simultaneously, content below the
  // viewport is unchanged and scrollBottom is invariant.
  const captureScrollBottom = useCallback(() => {
    const el = scrollElement.current
    if (!el) return
    const scrollBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    anchorRef.current = { scrollBottom }
    // Pre-update persistentAnchorRef so that any contentResize events that fire
    // before useLayoutEffect (anchor:scrollBottom) use the correct target.
    // Without this, a contentResize from a previous cycle can fire with a stale
    // scrollBottom and move scrollTop in the wrong direction — then anchor:scrollBottom
    // corrects it again, causing a visible double-jump at momentum end.
    //
    // Skip during momentum: anchor:scrollBottom is also skipped then, so scrollTop
    // won't actually be corrected yet — the persistent anchor will be set after
    // scrollend when the range update commits and useLayoutEffect runs.
    if (!userScrollIntent?.current) {
      persistentAnchorRef.current = { scrollBottom }
    }
  }, [scrollElement, userScrollIntent])

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
  // on Safari (no overflow-anchor). The persistentAnchorRef stores the target
  // scrollBottom and this observer reapplies it until the user scrolls.
  useLayoutEffect(() => {
    const content = contentElement?.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const pa = persistentAnchorRef.current
      if (!pa || userScrollIntent?.current) return
      const el = scrollElement.current
      if (!el) return
      const newScrollTop = el.scrollHeight - el.clientHeight - pa.scrollBottom
      if (Math.abs(el.scrollTop - newScrollTop) > 2) {
        programmaticScrollRef.current = true
        el.scrollTop = newScrollTop
      }
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [contentElement, scrollElement, userScrollIntent])

  // ---- Count changes: non-prepend adjustments (append, filter, initial load) ----
  // Prepend is already handled in render phase above. This effect handles the rest.
  useLayoutEffect(() => {
    // Skip if render-phase prepend detection already adjusted the range.
    // The count-change effect would otherwise override the shifted range with
    // a stale calculation, causing a visual jump.
    if (prependHandledRef.current) {
      prependHandledRef.current = false
      prevFirstKeyRef.current = count > 0 ? getKey(0) : undefined
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
      console.log('[VirtualList] count change (stick):', {
        count,
        viewportHeight,
        visibleCount,
        nextRange,
        scrollElExists: !!scrollElement.current,
      })
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

    prevFirstKeyRef.current = count > 0 ? getKey(0) : undefined
  }, [count, getKey, shouldStick, scrollElement, estimateSize, overscan])

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
    // Keep the target scrollBottom alive so the content ResizeObserver can
    // reapply it as newly-rendered items settle to their real heights.
    // (On Safari, each item resize changes scrollHeight without adjusting
    // scrollTop; persistentAnchorRef lets us compensate each time.)
    persistentAnchorRef.current = { scrollBottom: anchor.scrollBottom }
  }, [range.startIndex, range.endIndex, scrollElement, userScrollIntent])


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
