import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { scrollDebug } from '~/lib/scroll-debug'

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
  const { count, estimateSize, overscanPx, scrollElement, getKey, shouldStick, userScrollIntent } = options
  const overscan = Math.ceil(overscanPx / estimateSize)

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
  // We manually anchor: before a range change, record a visible element's viewport
  // offset; after DOM commit, restore it by adjusting scrollTop.
  const anchorRef = useRef<{ element: Element; topOffset: number } | null>(null)

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
          scrollDebug('📦', 'prepend:detected', {
            prependCount,
            oldRange: `[${range.startIndex}, ${range.endIndex})`,
            newRange: `[${newStart}, ${newEnd})`,
            scrollHeight: el?.scrollHeight,
            scrollTop: el ? Math.round(el.scrollTop) : undefined,
          })
          prependHandledRef.current = true
          setRange({ startIndex: newStart, endIndex: newEnd })
        }
      }
      // Update ref regardless of whether it was a prepend (handles replacements too)
      prevFirstKeyRef.current = currentFirstKey
    }
  }

  // ---- Range update (called from scroll listener and effects) ----

  // Capture a visible element as a scroll anchor before range changes.
  // Uses data-vi (virtual index) attributes on rendered items.
  const captureAnchor = useCallback(() => {
    const el = scrollElement.current
    if (!el) return
    // Find the element near viewport center for best stability
    const centerVi = Math.floor((el.scrollTop + el.clientHeight / 2) / estimateSize)
    // Clamp to the currently rendered range
    const vi = Math.max(range.startIndex, Math.min(range.endIndex - 1, centerVi))
    const anchorEl = el.querySelector(`[data-vi="${vi}"]`)
    if (anchorEl) {
      const elRect = el.getBoundingClientRect()
      anchorRef.current = {
        element: anchorEl,
        topOffset: anchorEl.getBoundingClientRect().top - elRect.top,
      }
    }
  }, [scrollElement, estimateSize, range.startIndex, range.endIndex])

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

        const nearTopEdge = viewportTop < renderedTop + edgePx
        const nearBottomEdge = viewportBottom > renderedBottom - edgePx

        if (!nearTopEdge && !nearBottomEdge) {
          // Safely inside buffer — freeze
          scrollDebug('🧊', 'range:frozen', {
            reason: 'inside buffer',
            range: `[${prev.startIndex}, ${prev.endIndex})`,
            viewportTop: Math.round(viewportTop),
            viewportBottom: Math.round(viewportBottom),
            renderedTop: Math.round(renderedTop),
            renderedBottom: Math.round(renderedBottom),
          })
          return prev
        }

        // Near edge — expand-only (never shrink) to prevent blank space
        const startIndex = Math.min(prev.startIndex, next.startIndex)
        const endIndex = Math.max(prev.endIndex, next.endIndex)
        if (startIndex === prev.startIndex && endIndex === prev.endIndex) return prev
        // Capture anchor before DOM changes (edge expand during scroll)
        if (startIndex !== prev.startIndex) captureAnchor()
        scrollDebug('🧊', 'range:edgeExpand', {
          nearTopEdge,
          nearBottomEdge,
          prev: `[${prev.startIndex}, ${prev.endIndex})`,
          next: `[${startIndex}, ${endIndex})`,
        })
        return { startIndex, endIndex }
      }

      // When idle: expand immediately, shrink lazily (items removed only when
      // more than 2×overscan away from the calculated viewport edge).
      const startIndex = Math.max(
        Math.min(prev.startIndex, next.startIndex),
        next.startIndex - overscan,
      )
      const endIndex = Math.min(
        Math.max(prev.endIndex, next.endIndex),
        next.endIndex + overscan,
      )

      if (startIndex === prev.startIndex && endIndex === prev.endIndex) return prev
      // Capture anchor before DOM changes when startIndex moves
      if (startIndex !== prev.startIndex) captureAnchor()
      scrollDebug('🔄', 'range:update', {
        prev: `[${prev.startIndex}, ${prev.endIndex})`,
        next: `[${startIndex}, ${endIndex})`,
        scrollTop: Math.round(el.scrollTop),
      })
      return { startIndex, endIndex }
    })
  }, [scrollElement, count, estimateSize, overscan, userScrollIntent, captureAnchor])

  // ---- Scroll listener (passive) ----
  // Also listen for scrollend to update range after momentum scroll ends
  // (range updates are frozen during userScrollIntent).
  useLayoutEffect(() => {
    const el = scrollElement.current
    if (!el) return
    el.addEventListener('scroll', updateRange, { passive: true })
    el.addEventListener('scrollend', updateRange, { passive: true })
    return () => {
      el.removeEventListener('scroll', updateRange)
      el.removeEventListener('scrollend', updateRange)
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
      scrollDebug('📦', 'count:change+stick', {
        count,
        range: `[${nextRange.startIndex}, ${nextRange.endIndex})`,
      })
      setRange(nextRange)
    } else {
      // Not at bottom: keep start position, extend end if needed
      scrollDebug('📦', 'count:change', { count, shouldStick: false })
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
        scrollDebug('📦', 'prepend:scrollRestore:skip', { reason: 'momentum active', heightAdded })
        return
      }
      const expectedScrollTop = prependSnap.scrollTop + heightAdded
      if (Math.abs(el.scrollTop - expectedScrollTop) > 2) {
        el.scrollTop = expectedScrollTop
      }
      scrollDebug('📦', 'prepend:scrollRestore', {
        snapScrollTop: Math.round(prependSnap.scrollTop),
        heightAdded,
        expectedScrollTop: Math.round(expectedScrollTop),
        actualScrollTop: Math.round(el.scrollTop),
      })
      anchorRef.current = null // clear any stale anchor
      return
    }

    // Anchor-based restoration for range changes (startIndex moved)
    const anchor = anchorRef.current
    if (!anchor) return
    anchorRef.current = null
    const el = scrollElement.current
    if (!el || !anchor.element.isConnected) return
    if (userScrollIntent?.current) {
      scrollDebug('⚓', 'anchor:skip', { reason: 'momentum active' })
      return
    }
    const elRect = el.getBoundingClientRect()
    const newTopOffset = anchor.element.getBoundingClientRect().top - elRect.top
    const drift = newTopOffset - anchor.topOffset
    if (Math.abs(drift) > 2) {
      el.scrollTop += drift
      scrollDebug('⚓', 'anchor:restore', {
        drift: Math.round(drift),
        scrollTop: Math.round(el.scrollTop),
      })
    }
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
