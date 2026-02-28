import { useCallback, useEffect, useRef } from 'react'

/**
 * Threshold (in pixels) for considering the user "at the bottom".
 * Accounts for sub-pixel rounding and minor layout shifts.
 */
const AT_BOTTOM_THRESHOLD = 50

/**
 * useStickToBottom — replaces the `use-stick-to-bottom` npm library.
 *
 * Tracks whether the user is scrolled to the bottom of a scroll container
 * and auto-scrolls when new content arrives while at-bottom. Disengages
 * when the user scrolls up; re-engages when they scroll back down.
 *
 * Handles mobile momentum scrolling by listening to both `scroll` and
 * `scrollend` events (the latter fires after iOS/Safari momentum ends).
 */
export function useStickToBottom() {
  const scrollElementRef = useRef<HTMLDivElement | null>(null)
  const contentElementRef = useRef<HTMLDivElement | null>(null)
  const isAtBottomRef = useRef<boolean>(true)
  const shouldStickRef = useRef<boolean>(true)

  // RAF guard to debounce scroll checks
  const rafRef = useRef<number | null>(null)
  const settleRafRef = useRef<number | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const isProgrammaticScrollRef = useRef(false)

  const checkIsAtBottom = useCallback((el: HTMLDivElement): boolean => {
    const { scrollTop, scrollHeight, clientHeight } = el
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    return distanceFromBottom <= AT_BOTTOM_THRESHOLD
  }, [])

  const clearProgrammaticScroll = useCallback(() => {
    if (settleRafRef.current !== null) {
      cancelAnimationFrame(settleRafRef.current)
    }

    // Give the browser one extra frame to apply the scroll position and emit
    // any resulting scroll event before we resume treating scroll as user input.
    settleRafRef.current = requestAnimationFrame(() => {
      settleRafRef.current = requestAnimationFrame(() => {
        settleRafRef.current = null
        isProgrammaticScrollRef.current = false

        const el = scrollElementRef.current
        if (!el) return

        const atBottom = checkIsAtBottom(el)
        isAtBottomRef.current = atBottom
        if (atBottom) {
          shouldStickRef.current = true
        }
      })
    })
  }, [checkIsAtBottom])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'instant') => {
    const el = scrollElementRef.current
    if (!el) return
    isProgrammaticScrollRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior })
    isAtBottomRef.current = true
    shouldStickRef.current = true
    clearProgrammaticScroll()
  }, [clearProgrammaticScroll])

  const stickIfNeeded = useCallback(() => {
    if (shouldStickRef.current) {
      scrollToBottom('instant')
    }
  }, [scrollToBottom])

  // Store event handlers in refs so the same function identity is used for
  // addEventListener and removeEventListener, even if the scroll element changes.
  // All closed-over values (scrollElementRef, isAtBottomRef, rafRef, checkIsAtBottom)
  // are refs or stable callbacks, so the handlers are correct across renders.
  const handleScrollRef = useRef(function handleScroll() {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const el = scrollElementRef.current
      if (!el) return
      const atBottom = checkIsAtBottom(el)
      isAtBottomRef.current = atBottom

      if (atBottom) {
        shouldStickRef.current = true
      } else if (!isProgrammaticScrollRef.current) {
        shouldStickRef.current = false
      }
    })
  })

  const handleScrollEndRef = useRef(function handleScrollEnd() {
    const el = scrollElementRef.current
    if (!el) return
    const atBottom = checkIsAtBottom(el)
    isAtBottomRef.current = atBottom
    if (atBottom) {
      shouldStickRef.current = true
    } else if (!isProgrammaticScrollRef.current) {
      shouldStickRef.current = false
    }
  })

  /**
   * Callback ref — sets up scroll listeners when element is assigned.
   */
  const setScrollElement = useCallback((el: HTMLDivElement | null) => {
    const handleScroll = handleScrollRef.current
    const handleScrollEnd = handleScrollEndRef.current

    // Clean up old listeners
    const prevEl = scrollElementRef.current
    if (prevEl && prevEl !== el) {
      prevEl.removeEventListener('scroll', handleScroll)
      prevEl.removeEventListener('scrollend', handleScrollEnd)
    }

    scrollElementRef.current = el

    if (!el) return

    // Opening a chat should start pinned to the latest content until the user
    // explicitly scrolls away.
    shouldStickRef.current = true
    isAtBottomRef.current = checkIsAtBottom(el)

    el.addEventListener('scroll', handleScroll, { passive: true })
    el.addEventListener('scrollend', handleScrollEnd, { passive: true })
    requestAnimationFrame(() => {
      stickIfNeeded()
    })
  }, [checkIsAtBottom, stickIfNeeded])

  /**
   * Callback ref — observes content height changes so sticky mode follows the
   * real rendered height instead of relying on callers to signal updates.
   */
  const setContentElement = useCallback((el: HTMLDivElement | null) => {
    if (resizeObserverRef.current && contentElementRef.current) {
      resizeObserverRef.current.unobserve(contentElementRef.current)
    }

    contentElementRef.current = el

    if (!el || typeof ResizeObserver === 'undefined') return

    if (!resizeObserverRef.current) {
      resizeObserverRef.current = new ResizeObserver(() => {
        stickIfNeeded()
      })
    }

    resizeObserverRef.current.observe(el)
    requestAnimationFrame(() => {
      stickIfNeeded()
    })
  }, [stickIfNeeded])

  // Clean up on unmount
  useEffect(() => {
    const handleScroll = handleScrollRef.current
    const handleScrollEnd = handleScrollEndRef.current

    return () => {
      const el = scrollElementRef.current
      if (el) {
        el.removeEventListener('scroll', handleScroll)
        el.removeEventListener('scrollend', handleScrollEnd)
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
      }
      if (settleRafRef.current !== null) {
        cancelAnimationFrame(settleRafRef.current)
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
      }
    }
  }, [])

  return {
    isAtBottom: isAtBottomRef,
    shouldStick: shouldStickRef,
    scrollToBottom,
    setScrollElement,
    setContentElement,
  }
}
