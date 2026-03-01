import { useCallback, useEffect, useRef } from 'react'

// ============================================================================
// Types
// ============================================================================

type ScrollPhase = 'idle' | 'user' | 'programmatic'

interface ScrollControllerOptions {
  /** Distance from bottom to consider "at bottom" (default: 50px) */
  stickyThreshold?: number
  /** Scroll delta before toggling input hide/show (default: 50px) */
  hideScrollThreshold?: number
  /** Distance from bottom to always show input (default: 100px) */
  hideBottomThreshold?: number
  /** Distance from top to trigger history loading (default: 1000px) */
  topLoadThreshold?: number
  /** Called when hide-on-scroll state changes (true = hidden) */
  onHideChange?: (hidden: boolean) => void
  /** Called when user scrolls near the top (for loading older messages) */
  onNearTop?: () => void
}

interface ScrollControllerReturn {
  /** Callback ref — attach to the scroll container element */
  scrollRef: (el: HTMLDivElement | null) => void
  /** Callback ref — attach to the content wrapper (observed for resize) */
  contentRef: (el: HTMLDivElement | null) => void
  /** Ref to the scroll container element (for virtualizer's getScrollElement) */
  scrollElement: React.RefObject<HTMLDivElement | null>
  /** Whether auto-scroll-to-bottom is engaged */
  shouldStick: React.RefObject<boolean>
  /** Whether the user is currently at the bottom */
  isAtBottom: React.RefObject<boolean>
  /** Programmatically scroll to the bottom */
  scrollToBottom: (behavior?: ScrollBehavior) => void
  /** Force-show the input (e.g., when opening a modal) */
  showInput: () => void
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_STICKY_THRESHOLD = 50
const DEFAULT_HIDE_SCROLL_THRESHOLD = 50
const DEFAULT_HIDE_BOTTOM_THRESHOLD = 100
const DEFAULT_TOP_LOAD_THRESHOLD = 1000

// ============================================================================
// Hook
// ============================================================================

/**
 * useScrollController — unified scroll behavior for the chat message list.
 *
 * Replaces useStickToBottom + useHideOnScroll + inline scroll listeners.
 * Owns one scroll listener, tracks interaction phase, and runs all behavior
 * in a single synchronous pass per event.
 *
 * Phase model:
 *   idle ──scroll event──► user ──scrollend──► idle
 *   idle ──scrollToBottom()──► programmatic ──scrollend──► idle
 *
 * Key invariant: stickIfNeeded() only fires during `idle` phase, so
 * ResizeObserver can never yank the scroll during user interaction.
 */
export function useScrollController(options: ScrollControllerOptions = {}): ScrollControllerReturn {
  const {
    stickyThreshold = DEFAULT_STICKY_THRESHOLD,
    hideScrollThreshold = DEFAULT_HIDE_SCROLL_THRESHOLD,
    hideBottomThreshold = DEFAULT_HIDE_BOTTOM_THRESHOLD,
    topLoadThreshold = DEFAULT_TOP_LOAD_THRESHOLD,
    onHideChange,
    onNearTop,
  } = options

  // ---- Element refs ----
  const scrollElementRef = useRef<HTMLDivElement | null>(null)
  const contentElementRef = useRef<HTMLDivElement | null>(null)

  // ---- Phase tracking ----
  const phaseRef = useRef<ScrollPhase>('idle')

  // ---- Sticky state ----
  const isAtBottomRef = useRef<boolean>(true)
  const shouldStickRef = useRef<boolean>(true)

  // ---- Hide-on-scroll state ----
  const lastScrollTopRef = useRef<number>(0)
  const accumulatedDeltaRef = useRef<number>(0)
  const isHiddenRef = useRef<boolean>(false)

  // ---- ResizeObserver ----
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  // ---- Stable callback refs (survive re-renders without re-attaching listeners) ----
  const onHideChangeRef = useRef(onHideChange)
  const onNearTopRef = useRef(onNearTop)
  onHideChangeRef.current = onHideChange
  onNearTopRef.current = onNearTop

  // ============================================================================
  // Core: check if at bottom
  // ============================================================================

  const checkIsAtBottom = useCallback(
    (el: HTMLDivElement): boolean => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      return distanceFromBottom <= stickyThreshold
    },
    [stickyThreshold],
  )

  // ============================================================================
  // Programmatic scroll
  // ============================================================================

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'instant') => {
      const el = scrollElementRef.current
      if (!el) return
      phaseRef.current = 'programmatic'
      el.scrollTo({ top: el.scrollHeight, behavior })
      isAtBottomRef.current = true
      shouldStickRef.current = true
    },
    [],
  )

  const stickIfNeeded = useCallback(() => {
    if (phaseRef.current !== 'idle') return // ◄ phase gate
    if (shouldStickRef.current) {
      scrollToBottom('instant')
    }
  }, [scrollToBottom])

  // ============================================================================
  // Scroll event handler (single listener, synchronous)
  // ============================================================================

  // Stored in a ref so addEventListener/removeEventListener use the same identity.
  // All closed-over values are refs or stable callbacks — safe across renders.
  const handleScrollRef = useRef(function handleScroll() {
    const el = scrollElementRef.current
    if (!el) return

    // ---- 1. Read metrics (once) ----
    const scrollTop = el.scrollTop
    const distanceFromBottom = el.scrollHeight - scrollTop - el.clientHeight

    // ---- 2. Phase gate ----
    if (phaseRef.current === 'programmatic') {
      // During programmatic scroll, only update position tracking for hide-on-scroll
      lastScrollTopRef.current = scrollTop
      return
    }

    // Mark phase as user-driven (first scroll event transitions idle → user)
    if (phaseRef.current === 'idle') {
      phaseRef.current = 'user'
    }

    // ---- 3. Sticky (synchronous — no RAF) ----
    const atBottom = distanceFromBottom <= stickyThreshold
    isAtBottomRef.current = atBottom

    if (atBottom) {
      shouldStickRef.current = true
    } else {
      shouldStickRef.current = false
    }

    // ---- 4. Hide-on-scroll ----
    const delta = scrollTop - lastScrollTopRef.current
    const nearBottom = distanceFromBottom <= hideBottomThreshold

    if (nearBottom) {
      // Always show input at bottom
      if (isHiddenRef.current) {
        isHiddenRef.current = false
        onHideChangeRef.current?.(false)
      }
      accumulatedDeltaRef.current = 0
    } else {
      // Accumulate delta, reset on direction change
      if (
        (delta > 0 && accumulatedDeltaRef.current < 0) ||
        (delta < 0 && accumulatedDeltaRef.current > 0)
      ) {
        accumulatedDeltaRef.current = delta
      } else {
        accumulatedDeltaRef.current += delta
      }

      if (accumulatedDeltaRef.current > hideScrollThreshold && isHiddenRef.current) {
        // Scrolling down → show input
        isHiddenRef.current = false
        onHideChangeRef.current?.(false)
        accumulatedDeltaRef.current = 0
      } else if (accumulatedDeltaRef.current < -hideScrollThreshold && !isHiddenRef.current) {
        // Scrolling up → hide input
        isHiddenRef.current = true
        onHideChangeRef.current?.(true)
        accumulatedDeltaRef.current = 0
      }
    }

    // ---- 5. History paging (scroll-up near top) ----
    const scrollingUp = delta < 0
    if (scrollingUp && scrollTop < topLoadThreshold && !shouldStickRef.current) {
      onNearTopRef.current?.()
    }

    lastScrollTopRef.current = scrollTop
  })

  // ============================================================================
  // Scrollend handler — finalize phase
  // ============================================================================

  const handleScrollEndRef = useRef(function handleScrollEnd() {
    const el = scrollElementRef.current
    if (!el) return

    // Finalize sticky state after momentum ends
    const atBottom = checkIsAtBottom(el)
    isAtBottomRef.current = atBottom
    if (atBottom) {
      shouldStickRef.current = true
    }
    // If phase was programmatic and we ended NOT at bottom, disengage stick
    if (phaseRef.current === 'programmatic' && !atBottom) {
      shouldStickRef.current = false
    }

    // Return to idle — ResizeObserver may now call stickIfNeeded()
    phaseRef.current = 'idle'
  })

  // ============================================================================
  // Callback ref: scroll element
  // ============================================================================

  const scrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      const handleScroll = handleScrollRef.current
      const handleScrollEnd = handleScrollEndRef.current

      // Clean up previous element
      const prevEl = scrollElementRef.current
      if (prevEl && prevEl !== el) {
        prevEl.removeEventListener('scroll', handleScroll)
        prevEl.removeEventListener('scrollend', handleScrollEnd)
      }

      scrollElementRef.current = el

      if (!el) return

      // Initialize state
      shouldStickRef.current = true
      isAtBottomRef.current = checkIsAtBottom(el)
      lastScrollTopRef.current = el.scrollTop
      phaseRef.current = 'idle'

      el.addEventListener('scroll', handleScroll, { passive: true })
      el.addEventListener('scrollend', handleScrollEnd, { passive: true })

      // Initial stick
      requestAnimationFrame(() => {
        stickIfNeeded()
      })
    },
    [checkIsAtBottom, stickIfNeeded],
  )

  // ============================================================================
  // Callback ref: content element (ResizeObserver for auto-scroll on growth)
  // ============================================================================

  const contentRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (resizeObserverRef.current && contentElementRef.current) {
        resizeObserverRef.current.unobserve(contentElementRef.current)
      }

      contentElementRef.current = el

      if (!el || typeof ResizeObserver === 'undefined') return

      if (!resizeObserverRef.current) {
        resizeObserverRef.current = new ResizeObserver(() => {
          stickIfNeeded() // phase-gated: only acts during idle
        })
      }

      resizeObserverRef.current.observe(el)
      requestAnimationFrame(() => {
        stickIfNeeded()
      })
    },
    [stickIfNeeded],
  )

  // ============================================================================
  // Manual show (for overlays, modals, etc.)
  // ============================================================================

  const showInput = useCallback(() => {
    if (isHiddenRef.current) {
      isHiddenRef.current = false
      onHideChangeRef.current?.(false)
    }
    accumulatedDeltaRef.current = 0
  }, [])

  // ============================================================================
  // Cleanup on unmount
  // ============================================================================

  useEffect(() => {
    const handleScroll = handleScrollRef.current
    const handleScrollEnd = handleScrollEndRef.current

    return () => {
      const el = scrollElementRef.current
      if (el) {
        el.removeEventListener('scroll', handleScroll)
        el.removeEventListener('scrollend', handleScrollEnd)
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
      }
    }
  }, [])

  return {
    scrollRef,
    contentRef,
    scrollElement: scrollElementRef,
    shouldStick: shouldStickRef,
    isAtBottom: isAtBottomRef,
    scrollToBottom,
    showInput,
  }
}
