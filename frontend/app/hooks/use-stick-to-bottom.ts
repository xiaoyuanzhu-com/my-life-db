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
  const isAtBottomRef = useRef<boolean>(true)

  // RAF guard to debounce scroll checks
  const rafRef = useRef<number | null>(null)

  const checkIsAtBottom = useCallback((el: HTMLDivElement): boolean => {
    const { scrollTop, scrollHeight, clientHeight } = el
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    return distanceFromBottom <= AT_BOTTOM_THRESHOLD
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'instant') => {
    const el = scrollElementRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    isAtBottomRef.current = true
  }, [])

  /**
   * Called after content changes (new messages, streaming updates, etc.)
   * to auto-scroll if the user is currently at bottom.
   */
  const onContentChange = useCallback(() => {
    if (isAtBottomRef.current) {
      // Use rAF to ensure layout has been calculated after the DOM update
      requestAnimationFrame(() => {
        scrollToBottom('instant')
      })
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
      isAtBottomRef.current = checkIsAtBottom(el)
    })
  })

  const handleScrollEndRef = useRef(function handleScrollEnd() {
    const el = scrollElementRef.current
    if (!el) return
    isAtBottomRef.current = checkIsAtBottom(el)
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

    // Initial state: start at bottom
    isAtBottomRef.current = checkIsAtBottom(el)

    el.addEventListener('scroll', handleScroll, { passive: true })
    el.addEventListener('scrollend', handleScrollEnd, { passive: true })
  }, [checkIsAtBottom])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      const el = scrollElementRef.current
      if (el) {
        el.removeEventListener('scroll', handleScrollRef.current)
        el.removeEventListener('scrollend', handleScrollEndRef.current)
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [])

  return {
    isAtBottom: isAtBottomRef,
    scrollToBottom,
    setScrollElement,
    onContentChange,
  }
}
