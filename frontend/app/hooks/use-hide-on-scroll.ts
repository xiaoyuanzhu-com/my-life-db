import { useEffect, useRef, useState, useCallback } from 'react'

interface UseHideOnScrollOptions {
  /** Scroll distance threshold before triggering hide/show (default: 50px) */
  threshold?: number
  /** Distance from bottom to consider "at bottom" (default: 100px) */
  bottomThreshold?: number
}

interface UseHideOnScrollResult {
  /** Whether the element should be hidden */
  shouldHide: boolean
  /** Manual override to show the element */
  show: () => void
}

/**
 * Hook to hide an element when scrolling up and show when scrolling down or at bottom.
 * Designed for mobile chat input hide-on-scroll pattern.
 *
 * @param scrollElement - The scrollable container element (or null)
 * @param options - Configuration options
 */
export function useHideOnScroll(
  scrollElement: HTMLElement | null,
  options: UseHideOnScrollOptions = {}
): UseHideOnScrollResult {
  const { threshold = 50, bottomThreshold = 100 } = options

  const [shouldHide, setShouldHide] = useState(false)
  const lastScrollTop = useRef(0)
  const accumulatedDelta = useRef(0)

  // Check if scroll position is near the bottom
  const isNearBottom = useCallback((el: HTMLElement): boolean => {
    const { scrollTop, scrollHeight, clientHeight } = el
    return scrollHeight - scrollTop - clientHeight < bottomThreshold
  }, [bottomThreshold])

  // Manual show override
  const show = useCallback(() => {
    setShouldHide(false)
    accumulatedDelta.current = 0
  }, [])

  useEffect(() => {
    if (!scrollElement) return

    const handleScroll = () => {
      const currentScrollTop = scrollElement.scrollTop
      const delta = currentScrollTop - lastScrollTop.current

      // Reset at bottom - always show input
      if (isNearBottom(scrollElement)) {
        setShouldHide(false)
        accumulatedDelta.current = 0
        lastScrollTop.current = currentScrollTop
        return
      }

      // Accumulate scroll delta in current direction
      if ((delta > 0 && accumulatedDelta.current < 0) || (delta < 0 && accumulatedDelta.current > 0)) {
        // Direction changed - reset accumulator
        accumulatedDelta.current = delta
      } else {
        accumulatedDelta.current += delta
      }

      // Check if accumulated delta exceeds threshold
      if (accumulatedDelta.current > threshold) {
        // Scrolling down (towards bottom) - show input
        setShouldHide(false)
        accumulatedDelta.current = 0
      } else if (accumulatedDelta.current < -threshold) {
        // Scrolling up (towards top) - hide input
        setShouldHide(true)
        accumulatedDelta.current = 0
      }

      lastScrollTop.current = currentScrollTop
    }

    scrollElement.addEventListener('scroll', handleScroll, { passive: true })
    return () => scrollElement.removeEventListener('scroll', handleScroll)
  }, [scrollElement, threshold, isNearBottom])

  return { shouldHide, show }
}
