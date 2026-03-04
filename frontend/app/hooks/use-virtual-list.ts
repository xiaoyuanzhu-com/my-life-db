import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { scrollDebug } from './use-scroll-controller'

// ============================================================================
// Types
// ============================================================================

interface VirtualListOptions {
  /** Total number of items */
  count: number
  /** Estimated height per item in pixels */
  estimateSize: number
  /** Number of extra items to render above/below the visible range */
  overscan: number
  /** Ref to the scroll container element */
  scrollElement: React.RefObject<HTMLDivElement | null>
  /** Stable function returning a unique key for the given index */
  getKey: (index: number) => string | number
  /** Whether the list should initialize from the bottom (stick-to-bottom) */
  shouldStick: React.RefObject<boolean>
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
  const rawStart = Math.floor(scrollTop / estimateSize)
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
  const { count, estimateSize, overscan, scrollElement, getKey, shouldStick } = options

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
          scrollDebug.enabled && console.log('[vlist-debug] PREPEND (render-phase)', { prependCount, from: `${range.startIndex}-${range.endIndex}`, to: `${newStart}-${newEnd}`, topH: `${range.startIndex * estimateSize}→${newStart * estimateSize}` })
          setRange({ startIndex: newStart, endIndex: newEnd })
        }
      }
      // Update ref regardless of whether it was a prepend (handles replacements too)
      prevFirstKeyRef.current = currentFirstKey
    }
  }

  // ---- Range update (called from scroll listener and effects) ----
  const updateRange = useCallback(() => {
    const el = scrollElement.current
    if (!el || count === 0) return
    const next = calcRange(el.scrollTop, el.clientHeight, count, estimateSize, overscan)
    setRange((prev) => {
      if (prev.startIndex === next.startIndex && prev.endIndex === next.endIndex) return prev
      // Hysteresis: when range changes by ≤1 at both boundaries, take the union
      // to prevent oscillation from items whose real height differs from estimateSize.
      // Rendering one extra item is cheaper than thrashing.
      if (Math.abs(next.startIndex - prev.startIndex) <= 1 && Math.abs(next.endIndex - prev.endIndex) <= 1) {
        const stable = {
          startIndex: Math.min(prev.startIndex, next.startIndex),
          endIndex: Math.max(prev.endIndex, next.endIndex),
        }
        if (stable.startIndex === prev.startIndex && stable.endIndex === prev.endIndex) return prev
        scrollDebug.enabled && console.log('[vlist-debug] updateRange (stabilized)', { from: `${prev.startIndex}-${prev.endIndex}`, to: `${stable.startIndex}-${stable.endIndex}`, scrollTop: el.scrollTop })
        return stable
      }
      scrollDebug.enabled && console.log('[vlist-debug] updateRange (scroll)', { from: `${prev.startIndex}-${prev.endIndex}`, to: `${next.startIndex}-${next.endIndex}`, scrollTop: el.scrollTop, topH: `${next.startIndex * estimateSize}→${prev.startIndex * estimateSize}` })
      return next
    })
  }, [scrollElement, count, estimateSize, overscan])

  // ---- Scroll listener (passive) ----
  useLayoutEffect(() => {
    const el = scrollElement.current
    if (!el) return
    el.addEventListener('scroll', updateRange, { passive: true })
    return () => el.removeEventListener('scroll', updateRange)
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
      scrollDebug.enabled && console.log('[vlist-debug] count change (sticky)', { count, range: `${nextRange.startIndex}-${nextRange.endIndex}`, topH: nextRange.startIndex * estimateSize })
      setRange(nextRange)
    } else {
      // Not at bottom: keep start position, extend end if needed
      setRange((prev) => {
        const viewportHeight = scrollElement.current?.clientHeight ?? 800
        const visibleCount = Math.ceil(viewportHeight / estimateSize)
        const endIndex = Math.min(count, prev.startIndex + visibleCount + 2 * overscan)
        if (prev.endIndex === endIndex) return prev
        scrollDebug.enabled && console.log('[vlist-debug] count change (non-sticky)', { count, from: `${prev.startIndex}-${prev.endIndex}`, to: `${prev.startIndex}-${endIndex}` })
        return { startIndex: prev.startIndex, endIndex }
      })
    }

    prevFirstKeyRef.current = count > 0 ? getKey(0) : undefined
  }, [count, getKey, shouldStick, scrollElement, estimateSize, overscan])

  // ---- Prepend scroll restoration ----
  // After React commits the shifted range to the DOM, restore scroll position
  // using the height delta. This is a manual scroll anchor — no dependency on
  // browser overflow-anchor behavior.
  useLayoutEffect(() => {
    const snap = prependSnapshotRef.current
    if (!snap) return
    prependSnapshotRef.current = null
    const el = scrollElement.current
    if (!el) return
    const heightAdded = el.scrollHeight - snap.scrollHeight
    if (heightAdded === 0) return
    // Only adjust if browser anchoring didn't already handle it
    const expectedScrollTop = snap.scrollTop + heightAdded
    if (Math.abs(el.scrollTop - expectedScrollTop) > 2) {
      el.scrollTop = expectedScrollTop
      scrollDebug.enabled && console.log('[vlist-debug] prepend scroll restore', { heightAdded, prevScrollTop: snap.scrollTop, newScrollTop: el.scrollTop, browserScrollTop: snap.scrollTop })
    } else {
      scrollDebug.enabled && console.log('[vlist-debug] prepend scroll restore (browser handled)', { heightAdded, scrollTop: el.scrollTop })
    }
  }, [range.startIndex, range.endIndex, scrollElement])

  // ---- Derived spacer heights ----
  const topHeight = range.startIndex * estimateSize
  const bottomHeight = Math.max(0, (count - range.endIndex) * estimateSize)

  // Log spacer height changes (only when they actually change)
  const prevSpacersRef = useRef({ topHeight: -1, bottomHeight: -1 })
  if (prevSpacersRef.current.topHeight !== topHeight || prevSpacersRef.current.bottomHeight !== bottomHeight) {
    scrollDebug.enabled && console.log('[vlist-debug] spacers', { topHeight, bottomHeight, range: `${range.startIndex}-${range.endIndex}`, count })
    prevSpacersRef.current = { topHeight, bottomHeight }
  }

  return {
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    topHeight,
    bottomHeight,
  }
}
