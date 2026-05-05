# Mobile Scroll Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix mobile scrolling on session detail page by making user physical interaction an absolute lock over programmatic scrolling.

**Architecture:** Add `fingerDownRef` tracking to the existing scroll controller, gate both `stickIfNeeded()` and the virtualizer's `shouldAdjustScrollPositionOnItemSizeChange` on it, remove the competing root scroller, and add `touch-action: pan-y`.

**Tech Stack:** React, TypeScript, @tanstack/react-virtual, CSS

---

### Task 1: Add finger-down tracking and export interaction refs (`use-scroll-controller.ts`)

**Files:**
- Modify: `frontend/app/hooks/use-scroll-controller.ts`

**Step 1: Add `fingerDownRef` and clear-finger handler**

After `userScrollIntentRef` (line 94), add:

```ts
const fingerDownRef = useRef<boolean>(false)
```

After `markUserScrollIntentRef` (line 153-155), add a new handler ref:

```ts
const clearFingerDownRef = useRef(function clearFingerDown() {
  fingerDownRef.current = false
})
```

And update `markUserScrollIntentRef` to also set `fingerDownRef`:

```ts
const markUserScrollIntentRef = useRef(function markUserScrollIntent() {
  userScrollIntentRef.current = true
  fingerDownRef.current = true
})
```

**Step 2: Gate `stickIfNeeded()` on both interaction signals**

Replace `stickIfNeeded` (lines 141-145):

```ts
const stickIfNeeded = useCallback(() => {
  if (phaseRef.current !== 'idle') return // phase gate
  if (fingerDownRef.current) return       // finger on screen — absolute lock
  if (userScrollIntentRef.current) return // momentum still going
  if (!shouldStickRef.current) return
  scrollToBottom('instant')
}, [scrollToBottom])
```

**Step 3: Register `touchend`/`pointerup` listeners**

In `scrollRef` callback — after the existing `el.addEventListener` block (line 291), add:

```ts
el.addEventListener('touchend', clearFingerDown, { passive: true })
el.addEventListener('pointerup', clearFingerDown, { passive: true })
```

In the cleanup block within `scrollRef` (where `prevEl` listeners are removed, lines 269-273), add:

```ts
prevEl.removeEventListener('touchend', clearFingerDown)
prevEl.removeEventListener('pointerup', clearFingerDown)
```

Also read `clearFingerDown` from ref at the top of `scrollRef`:

```ts
const clearFingerDown = clearFingerDownRef.current
```

In the unmount cleanup `useEffect` (lines 345-363), add the same removals:

```ts
el.removeEventListener('touchend', clearFingerDown)
el.removeEventListener('pointerup', clearFingerDown)
```

And read the ref at the top of the effect:

```ts
const clearFingerDown = clearFingerDownRef.current
```

**Step 4: Export the interaction refs**

Update `ScrollControllerReturn` interface (lines 24-39) to add:

```ts
/** Whether user's finger is physically on the scroll surface */
fingerDown: React.RefObject<boolean>
/** Whether user scroll intent is active (finger down OR momentum) */
userScrollIntent: React.RefObject<boolean>
```

Update the return statement (lines 365-373) to add:

```ts
fingerDown: fingerDownRef,
userScrollIntent: userScrollIntentRef,
```

**Step 5: Build and verify no type errors**

Run: `cd frontend && npx tsc --noEmit`

**Step 6: Commit**

```
feat(scroll): add finger-down tracking to block programmatic scroll during user touch
```

---

### Task 2: Gate virtualizer adjustments on user interaction (`message-list.tsx`)

**Files:**
- Modify: `frontend/app/components/claude/chat/message-list.tsx`

**Step 1: Destructure the new refs from useScrollController**

Update line 87 from:

```ts
const { scrollRef, contentRef, scrollElement, shouldStick } = useScrollController({
```

To:

```ts
const { scrollRef, contentRef, scrollElement, shouldStick, fingerDown, userScrollIntent } = useScrollController({
```

**Step 2: Update `shouldAdjustScrollPositionOnItemSizeChange`**

Replace lines 108-124:

```ts
useEffect(() => {
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    // User is physically interacting with the scroll surface — never fight
    // their gesture. This prevents the jumps on mobile where touch deltas
    // are small and sticky mode breaks slowly.
    if (fingerDown.current || userScrollIntent.current) {
      return false
    }

    if (shouldStick.current || historyPagingActiveRef.current) {
      return true
    }

    if (instance.isScrolling && instance.scrollDirection === 'backward') {
      return false
    }

    return item.start < (instance.scrollOffset ?? 0)
  }

  return () => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined
  }
}, [virtualizer, shouldStick, fingerDown, userScrollIntent])
```

**Step 3: Add `touchAction: 'pan-y'` to scroll container**

Update line 264 from:

```ts
style={{ overflowAnchor: 'none' }}
```

To:

```ts
style={{ overflowAnchor: 'none', touchAction: 'pan-y' }}
```

**Step 4: Build and verify no type errors**

Run: `cd frontend && npx tsc --noEmit`

**Step 5: Commit**

```
feat(scroll): gate virtualizer adjustments on user interaction + add touch-action
```

---

### Task 3: Eliminate competing root scroller (`root.tsx`)

**Files:**
- Modify: `frontend/app/root.tsx`

**Step 1: Remove `min-h-screen` from root div**

On line 62, change:

```ts
`antialiased grid grid-cols-1 grid-rows-[auto_minmax(0,1fr)] min-h-screen h-dvh w-full min-w-0 overflow-y-auto overflow-x-hidden${native ? ' native-app' : ''}`
```

To:

```ts
`antialiased grid grid-cols-1 grid-rows-[auto_minmax(0,1fr)] h-dvh w-full min-w-0 overflow-y-auto overflow-x-hidden${native ? ' native-app' : ''}`
```

This removes the competing scrollable layer on iOS Safari where `100vh` (min-h-screen) > `100dvh` (h-dvh).

**Step 2: Build and verify**

Run: `cd frontend && npx tsc --noEmit`

**Step 3: Commit**

```
fix(scroll): remove min-h-screen from root to eliminate competing scroller on iOS
```

---

### Task 4: Verify the full build

**Step 1: Run full build**

Run: `cd frontend && npm run build`

**Step 2: Squash into single commit if preferred, or keep as-is**

Three focused commits ready for push.
