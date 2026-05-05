# Mobile Scroll Fix — User Interaction Priority

**Date:** 2026-03-02
**Status:** Approved
**Builds on:** 2026-03-01-unified-scroll-controller-design.md

## Problem

Session detail page scrolling is broken on mobile (both Safari and iOS native app). Scroll doesn't follow finger, jumps randomly, can't reach desired position. Desktop works fine.

Root cause: the unified scroll controller's phase model has a gap — it only blocks programmatic scrolling when a `scroll` event has fired during user interaction. If the user touches the screen without scrolling (holding to read while messages stream in), no `scroll` event fires, phase stays `idle`, and `stickIfNeeded()` yanks the content away.

Additionally, the virtualizer's `shouldAdjustScrollPositionOnItemSizeChange` lets scroll corrections through when `shouldStick` is true, even during active user touch — causing jumps on mobile where touch deltas are small and sticky mode breaks slowly.

Three contributing issues on mobile Safari specifically:
1. Root div's `min-h-screen` makes it taller than `h-dvh` on iOS (100vh > 100dvh), creating a competing scrollable layer
2. Missing `touch-action: pan-y` on the message list scroll container

## Design Principle

**User physical interaction is an absolute lock.** Any touch (hold, pan, pinch) on the scroll surface immediately freezes all programmatic scrolling. The lock releases only after the finger lifts AND momentum settles.

## Changes

### Fix 1: Finger-down tracking (`use-scroll-controller.ts`)

Add `fingerDownRef` — tracks whether user is physically touching the scroll surface.

```
touchstart/pointerdown → fingerDownRef = true
touchend/pointerup     → fingerDownRef = false
```

Gate `stickIfNeeded()` on both signals:

```ts
if (phaseRef.current !== 'idle') return
if (fingerDownRef.current) return       // finger on screen
if (userScrollIntentRef.current) return // momentum still going
if (!shouldStickRef.current) return
scrollToBottom('instant')
```

Add `touchend`/`pointerup` listeners alongside existing `touchstart`/`pointerdown`. All passive.

Export `fingerDownRef` and `userScrollIntentRef` from the hook so the virtualizer can use them.

### Fix 2: Virtualizer respects user interaction (`message-list.tsx`)

```ts
virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
  // User is interacting — never fight their gesture
  if (fingerDown.current || userScrollIntent.current) return false

  if (shouldStick.current || historyPagingActiveRef.current) return true
  if (instance.isScrolling && instance.scrollDirection === 'backward') return false
  return item.start < (instance.scrollOffset ?? 0)
}
```

### Fix 3: Root container (`root.tsx`)

Remove `min-h-screen` from root div. `h-dvh` is sufficient — eliminates the competing scrollable layer on iOS Safari where 100vh > 100dvh.

### Fix 4: Touch action (`message-list.tsx`)

Add `touchAction: 'pan-y'` to the scroll container's inline style. Tells the browser to only allow vertical panning — prevents default touch negotiation from interfering with the virtualizer.

## Files Changed

| File | Change |
|------|--------|
| `app/hooks/use-scroll-controller.ts` | Add `fingerDownRef`, `touchend`/`pointerup` listeners, gate `stickIfNeeded`, export refs |
| `app/components/claude/chat/message-list.tsx` | Use exported refs in virtualizer callback, add `touchAction` style |
| `app/root.tsx` | Remove `min-h-screen` from root div |
