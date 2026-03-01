# Unified Scroll Controller — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace racing scroll hooks with a single unified controller that tracks interaction phase to eliminate scroll-yank bugs.

**Architecture:** One hook (`useScrollController`) owns the scroll element, attaches a single `scroll` + `scrollend` listener pair, and runs all behavior (sticky, hide-on-scroll, history paging) synchronously in one pass per event. A phase ref (`idle | user | programmatic`) gates side effects so ResizeObserver can never fight user input.

**Tech Stack:** React 19, TypeScript, @tanstack/react-virtual (unchanged — just feeds it the scroll element)

**Design doc:** `docs/plans/2026-03-01-unified-scroll-controller-design.md`

---

### Task 1: Create `useScrollController` hook

**Files:**
- Create: `frontend/app/hooks/use-scroll-controller.ts`

**Step 1: Create the hook file with full implementation**

```typescript
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
    if (phaseRef.current !== 'idle') return   // ◄ phase gate
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
    const scrollHeight = el.scrollHeight
    const clientHeight = el.clientHeight
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight

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
      if ((delta > 0 && accumulatedDeltaRef.current < 0) || (delta < 0 && accumulatedDeltaRef.current > 0)) {
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
          stickIfNeeded()  // phase-gated: only acts during idle
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
```

**Step 2: Verify the file compiles**

Run: `cd frontend && npx tsc --noEmit app/hooks/use-scroll-controller.ts` (or full project check)

---

### Task 2: Update `message-list.tsx` to use `useScrollController`

**Files:**
- Modify: `frontend/app/components/claude/chat/message-list.tsx`

**Step 1: Replace imports and hook usage**

Remove:
```typescript
import { useStickToBottom } from '~/hooks/use-stick-to-bottom'
```

Add:
```typescript
import { useScrollController } from '~/hooks/use-scroll-controller'
```

**Step 2: Replace the props interface**

Remove `onScrollElementReady` prop. Add `onHideChange` and history paging callbacks to be forwarded to the controller.

New `MessageListProps`:
```typescript
interface MessageListProps {
  messages: SessionMessage[]
  toolResultMap: Map<string, ExtractedToolResult>
  optimisticMessage?: string | null
  streamingText?: string
  streamingThinking?: string
  turnId?: number
  wipText?: string | null
  /** Called when hide-on-scroll state changes (true = hidden) */
  onHideChange?: (hidden: boolean) => void
  /** Whether a page of older messages is currently being loaded */
  isLoadingPage?: boolean
  /** Whether there are more historical pages available to load */
  hasMoreHistory?: boolean
  /** Callback to load the next older page of messages */
  onLoadOlderPage?: () => void
}
```

**Step 3: Replace hook initialization and remove scroll listener useEffect**

Replace the `useStickToBottom()` call, remove `scrollElementRef`, remove the `mergedScrollRef` callback, and remove the scroll-up detection `useEffect` (lines 134–163). The controller now handles all of this.

New initialization:
```typescript
const historyPagingActiveRef = useRef(false)
const pendingPrependAnchorRef = useRef<{ index: number; delta: number } | null>(null)
const prevFirstUuidRef = useRef<string | undefined>(filteredMessages[0]?.uuid)

// Unified scroll controller: owns scroll/scrollend listeners, sticky, hide-on-scroll, history paging
const { scrollRef, contentRef, scrollElement, shouldStick, scrollToBottom } = useScrollController({
  onHideChange,
  onNearTop: useCallback(() => {
    if (!onLoadOlderPage || !hasMoreHistory || isLoadingPage) return

    const element = scrollElement.current
    if (!element) return

    const scrollTop = element.scrollTop
    const anchor =
      virtualizer.getVirtualItems().find((item) => item.end > scrollTop) ??
      virtualizer.getVirtualItems()[0]

    if (anchor) {
      pendingPrependAnchorRef.current = {
        index: anchor.index,
        delta: Math.max(0, scrollTop - anchor.start),
      }
    } else {
      pendingPrependAnchorRef.current = null
    }

    historyPagingActiveRef.current = true
    onLoadOlderPage()
  }, [hasMoreHistory, isLoadingPage, onLoadOlderPage, scrollElement]),
})
```

Note: `virtualizer` is used inside `onNearTop`, so the virtualizer must be declared before the controller. Move the `useVirtualizer` call above the controller call and pass `scrollElement.current` via `getScrollElement: () => scrollElement.current`.

**Step 4: Update virtualizer to use controller's scrollElement ref**

```typescript
const virtualizer = useVirtualizer({
  count: filteredMessages.length,
  getScrollElement: () => scrollElement.current,
  estimateSize: () => 120,
  overscan: 5,
  getItemKey: (index) => filteredMessages[index]?.uuid ?? index,
})
```

**Step 5: Remove the inline scroll-up detection useEffect (lines 134–163)**

Delete the entire `useEffect` block that adds a `scroll` listener for history paging — the controller's `onNearTop` callback replaces it.

**Step 6: Update the continued-history-paging useEffect**

Keep this `useEffect` (lines 213–223) but update it to use `shouldStick` from the controller (same ref, same API — no change needed if the variable name is `shouldStick`).

**Step 7: Update the JSX**

Replace `mergedScrollRef` with `scrollRef`, replace `setContentElement` with `contentRef`:

```tsx
<div
  ref={scrollRef}
  className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 min-w-0 claude-interface claude-bg"
>
  <div ref={contentRef} className="w-full max-w-4xl mx-auto px-6 md:px-8 py-8 flex flex-col min-h-full">
```

**Step 8: Verify it compiles**

Run: `cd frontend && npx tsc --noEmit`

---

### Task 3: Update `chat-interface.tsx` to remove `useHideOnScroll`

**Files:**
- Modify: `frontend/app/components/claude/chat/chat-interface.tsx`

**Step 1: Remove imports and state**

Remove:
```typescript
import { useHideOnScroll } from '~/hooks/use-hide-on-scroll'
```

Remove the `scrollElement` state:
```typescript
const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
```

Remove the `useHideOnScroll` call:
```typescript
const { shouldHide: shouldHideInput } = useHideOnScroll(scrollElement, {
  threshold: 50,
  bottomThreshold: 100,
})
```

**Step 2: Add local state for hide-on-scroll, driven by controller callback**

```typescript
const [shouldHideInput, setShouldHideInput] = useState(false)

const handleHideChange = useCallback((hidden: boolean) => {
  setShouldHideInput(hidden)
}, [])
```

**Step 3: Update MessageList props**

Replace `onScrollElementReady={setScrollElement}` with `onHideChange={handleHideChange}`:

```tsx
<MessageList
  ...
  onHideChange={handleHideChange}
/>
```

**Step 4: Verify it compiles**

Run: `cd frontend && npx tsc --noEmit`

---

### Task 4: Delete old hooks

**Files:**
- Delete: `frontend/app/hooks/use-stick-to-bottom.ts`
- Delete: `frontend/app/hooks/use-hide-on-scroll.ts`

**Step 1: Delete the files**

```bash
rm frontend/app/hooks/use-stick-to-bottom.ts
rm frontend/app/hooks/use-hide-on-scroll.ts
```

**Step 2: Full compile check**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors. No remaining imports of the deleted hooks.

**Step 3: Grep for stale references**

Run: `grep -r 'use-stick-to-bottom\|use-hide-on-scroll\|useStickToBottom\|useHideOnScroll' frontend/app/`
Expected: No matches.

---

### Task 5: Build and smoke test

**Step 1: Full build**

Run: `cd frontend && npm run build`
Expected: Clean build, no errors.

**Step 2: Commit**

```bash
git add -A
git commit -m "refactor: unify scroll hooks into single phase-aware controller

Replace useStickToBottom + useHideOnScroll + inline scroll listener with
useScrollController. Tracks interaction phase (idle/user/programmatic) so
ResizeObserver can never yank scroll during user interaction. Eliminates
RAF race condition, removes React state updates during scroll events, and
reduces scroll listeners from 4 to 1 (plus TanStack Virtual's internal).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
