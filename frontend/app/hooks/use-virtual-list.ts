import { useCallback, useLayoutEffect, useRef, useState } from 'react'

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

  // ---- Range update (called from scroll listener and effects) ----
  const updateRange = useCallback(() => {
    const el = scrollElement.current
    if (!el || count === 0) return
    const next = calcRange(el.scrollTop, el.clientHeight, count, estimateSize, overscan)
    setRange((prev) => {
      if (prev.startIndex === next.startIndex && prev.endIndex === next.endIndex) return prev
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

  // ---- Count changes: prepend detection + range adjustment ----
  useLayoutEffect(() => {
    if (count === 0) {
      setRange({ startIndex: 0, endIndex: 0 })
      prevFirstKeyRef.current = undefined
      return
    }

    const prevFirstKey = prevFirstKeyRef.current
    const currentFirstKey = getKey(0)

    // Detect prepend: first key changed, old first key is deeper in the list
    if (prevFirstKey !== undefined && prevFirstKey !== currentFirstKey) {
      let prependCount = 0
      for (let i = 0; i < count; i++) {
        if (getKey(i) === prevFirstKey) {
          prependCount = i
          break
        }
      }
      if (prependCount > 0) {
        // Shift range so the same items stay rendered.
        // Browser scroll anchoring keeps the visual position stable.
        setRange((prev) => ({
          startIndex: Math.min(prev.startIndex + prependCount, count - 1),
          endIndex: Math.min(prev.endIndex + prependCount, count),
        }))
        prevFirstKeyRef.current = currentFirstKey
        return
      }
    }

    // Non-prepend count change (append, filter change, initial load)
    if (shouldStick.current) {
      // At bottom: extend range to include new items
      const viewportHeight = scrollElement.current?.clientHeight ?? 800
      const visibleCount = Math.ceil(viewportHeight / estimateSize)
      setRange({
        startIndex: Math.max(0, count - visibleCount - overscan),
        endIndex: count,
      })
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

    prevFirstKeyRef.current = currentFirstKey
  }, [count, getKey, shouldStick, scrollElement, estimateSize, overscan])

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
