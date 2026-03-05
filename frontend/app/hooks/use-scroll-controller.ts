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
  /** Whether user's finger is physically on the scroll surface */
  fingerDown: React.RefObject<boolean>
  /** Whether user scroll intent is active (finger down through momentum end) */
  userScrollIntent: React.RefObject<boolean>
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
const DEFAULT_TOP_LOAD_THRESHOLD = 5400 // should match overscanPx in useVirtualList

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
 * Key invariant: stickIfNeeded() is blocked when:
 *   1. phase === 'programmatic' (a scrollToBottom is already in flight)
 *   2. fingerDownRef is true (user's finger is on the scroll surface)
 *   3. shouldStick is false (user scrolled up, respects their intent)
 * This allows ResizeObserver to scroll-to-bottom during the 'user' phase
 * (e.g., desktop trackpad momentum) as long as the finger isn't on screen
 * and we know we want to stick. Previously, blocking on phase !== 'idle'
 * and userScrollIntent prevented stickIfNeeded from ever acting during
 * continuous trackpad wheel events.
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
  const lastDistFromBottomRef = useRef<number>(0)
  const accumulatedDeltaRef = useRef<number>(0)
  const isHiddenRef = useRef<boolean>(false)
  const userScrollIntentRef = useRef<boolean>(false)

  // ---- User interaction lock ----
  // Tracks whether the user's finger is physically on the scroll surface.
  // Separate from userScrollIntentRef (which persists through momentum).
  // When true, ALL programmatic scrolling is blocked — stickIfNeeded() and
  // virtualizer scroll adjustments must respect this as an absolute lock.
  const fingerDownRef = useRef<boolean>(false)

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
      const prevScrollTop = el.scrollTop
      phaseRef.current = 'programmatic'
      userScrollIntentRef.current = false
      el.scrollTo({ top: el.scrollHeight, behavior })
      isAtBottomRef.current = true
      shouldStickRef.current = true
      // If scroll position didn't change (no overflow or already at bottom),
      // scrollend won't fire — return to idle immediately so ResizeObserver
      // isn't blocked when content arrives later.
      if (el.scrollTop === prevScrollTop) {
        phaseRef.current = 'idle'
      }
    },
    [],
  )

  const stickIfNeeded = useCallback(() => {
    // Block if:
    // 1. A programmatic scroll is already in flight (prevent recursion)
    // 2. User's finger is physically on the screen (would fight touch input)
    // 3. Sticky is not engaged (user scrolled up, respect their intent)
    // Notably, we do NOT block on phase === 'user' or userScrollIntent.
    // If shouldStick is true and fingerDown is false, we should follow new
    // content even during wheel/trackpad momentum — the user wants to be
    // at the bottom, and there's no physical finger to fight.
    if (phaseRef.current === 'programmatic' || fingerDownRef.current || !shouldStickRef.current) return
    const el = scrollElementRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distFromBottom <= stickyThreshold) return
    scrollToBottom('instant')
  }, [scrollToBottom, stickyThreshold])

  // ============================================================================
  // Scroll event handler (single listener, synchronous)
  // ============================================================================

  // Stored in a ref so addEventListener/removeEventListener use the same identity.
  // All closed-over values are refs or stable callbacks — safe across renders.
  // Touch/pointer: finger is physically on the screen — block all programmatic scroll
  const markFingerDownRef = useRef(function markFingerDown() {
    userScrollIntentRef.current = true
    fingerDownRef.current = true
  })

  // Wheel: no physical finger on the surface — only mark scroll intent, NOT fingerDown.
  // fingerDown is a touch concept that blocks programmatic scroll while the user's
  // finger is on the screen. Wheel/trackpad scrolling doesn't need this guard because
  // there's no touchend/pointerup to clear it — it would stay true forever.
  const markWheelIntentRef = useRef(function markWheelIntent() {
    userScrollIntentRef.current = true
  })

  const clearFingerDownRef = useRef(function clearFingerDown() {
    fingerDownRef.current = false
  })

  const handleScrollRef = useRef(function handleScroll() {
    const el = scrollElementRef.current
    if (!el) return

    // ---- 1. Read metrics (once) ----
    const scrollTop = el.scrollTop
    const distanceFromBottom = el.scrollHeight - scrollTop - el.clientHeight
    const delta = scrollTop - lastScrollTopRef.current

    // ---- 2. Phase gate ----
    if (phaseRef.current === 'programmatic') {
      lastScrollTopRef.current = scrollTop
      lastDistFromBottomRef.current = distanceFromBottom
      return
    }

    const userDriven = userScrollIntentRef.current

    if (userDriven && phaseRef.current === 'idle') {
      phaseRef.current = 'user'
    }

    // ---- 3. Sticky (synchronous — no RAF) ----
    const atBottom = distanceFromBottom <= stickyThreshold
    isAtBottomRef.current = atBottom

    // Use distance-from-bottom delta to detect user scroll direction, NOT
    // scrollTop delta. scrollTop delta is unreliable because:
    //   1. Content height changes during streaming shift scrollTop without
    //      user action, creating false negative deltas
    //   2. iOS rubber-band bounce at the bottom creates negative scrollTop
    //      deltas during the bounce-back phase
    // Distance-from-bottom is immune to both: if the user is genuinely
    // scrolling up, distanceFromBottom increases. If content merely grew,
    // distanceFromBottom changes but scrollTop delta is the artifact.
    const prevDist = lastDistFromBottomRef.current
    const distDelta = distanceFromBottom - prevDist // positive = moving away from bottom
    lastDistFromBottomRef.current = distanceFromBottom

    if (userDriven && distDelta > 0 && distanceFromBottom > stickyThreshold) {
      shouldStickRef.current = false
    } else if (atBottom) {
      shouldStickRef.current = true
    }

    // ---- 4. Hide-on-scroll ----
    const nearBottom = distanceFromBottom <= hideBottomThreshold

    if (userDriven) {
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
          isHiddenRef.current = true
          onHideChangeRef.current?.(true)
          accumulatedDeltaRef.current = 0
        }
      }
    }

    // ---- 5. History paging (scroll-up near top) ----
    const scrollingUp = userDriven && delta < 0
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
    // Return to idle — ResizeObserver may now call stickIfNeeded()
    phaseRef.current = 'idle'
    userScrollIntentRef.current = false
  })

  // ============================================================================
  // Callback ref: scroll element
  // ============================================================================

  const scrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      const handleScroll = handleScrollRef.current
      const handleScrollEnd = handleScrollEndRef.current
      const markFingerDown = markFingerDownRef.current
      const markWheelIntent = markWheelIntentRef.current
      const clearFingerDown = clearFingerDownRef.current

      // Clean up previous element
      const prevEl = scrollElementRef.current
      if (prevEl && prevEl !== el) {
        prevEl.removeEventListener('scroll', handleScroll)
        prevEl.removeEventListener('scrollend', handleScrollEnd)
        prevEl.removeEventListener('wheel', markWheelIntent)
        prevEl.removeEventListener('touchstart', markFingerDown)
        prevEl.removeEventListener('pointerdown', markFingerDown)
        prevEl.removeEventListener('touchend', clearFingerDown)
        prevEl.removeEventListener('pointerup', clearFingerDown)
      }

      scrollElementRef.current = el

      if (!el) return

      // Initialize state
      shouldStickRef.current = true
      isAtBottomRef.current = checkIsAtBottom(el)
      lastScrollTopRef.current = el.scrollTop
      lastDistFromBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight
      phaseRef.current = 'idle'
      userScrollIntentRef.current = false
      fingerDownRef.current = false

      el.addEventListener('scroll', handleScroll, { passive: true })
      el.addEventListener('scrollend', handleScrollEnd, { passive: true })
      el.addEventListener('wheel', markWheelIntent, { passive: true })
      el.addEventListener('touchstart', markFingerDown, { passive: true })
      el.addEventListener('pointerdown', markFingerDown, { passive: true })
      el.addEventListener('touchend', clearFingerDown, { passive: true })
      el.addEventListener('pointerup', clearFingerDown, { passive: true })

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
        let prevContentHeight = -1
        resizeObserverRef.current = new ResizeObserver((entries) => {
          const h = entries[0]?.contentRect.height ?? 0
          if (h === prevContentHeight) return
          prevContentHeight = h
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
    const markFingerDown = markFingerDownRef.current
    const markWheelIntent = markWheelIntentRef.current
    const clearFingerDown = clearFingerDownRef.current

    return () => {
      const el = scrollElementRef.current
      if (el) {
        el.removeEventListener('scroll', handleScroll)
        el.removeEventListener('scrollend', handleScrollEnd)
        el.removeEventListener('wheel', markWheelIntent)
        el.removeEventListener('touchstart', markFingerDown)
        el.removeEventListener('pointerdown', markFingerDown)
        el.removeEventListener('touchend', clearFingerDown)
        el.removeEventListener('pointerup', clearFingerDown)
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
    fingerDown: fingerDownRef,
    userScrollIntent: userScrollIntentRef,
    scrollToBottom,
    showInput,
  }
}
