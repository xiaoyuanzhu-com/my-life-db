# Unified Scroll Controller

**Date:** 2026-03-01
**Status:** Approved

## Problem

The session detail page has five independent scroll listeners on the same element (`useStickToBottom`, `useHideOnScroll`, history paging in `message-list.tsx`, TanStack Virtual internal). They don't share state, so they race against each other:

1. `useStickToBottom` defers its `shouldStick` update to a RAF callback. If a ResizeObserver fires before that RAF runs (virtualizer measuring a new item), `stickIfNeeded()` yanks the scroll back to bottom while the user's finger is still dragging up.
2. `useHideOnScroll` calls `setShouldHide()` (React state) during scroll events, scheduling re-renders mid-interaction.
3. Four listeners each independently read `scrollTop`/`scrollHeight`/`clientHeight`, compounding main-thread work.

Root cause: scroll is a continuous interaction with phases (idle, user-driven, programmatic), but the code treats it as isolated events with no shared phase awareness.

## Design: Unified Scroll Controller

Replace `useStickToBottom` and `useHideOnScroll` with a single `useScrollController` hook that owns the scroll element, attaches one `scroll` + one `scrollend` listener, and runs all behavior logic in a single synchronous pass per event.

### Interaction Phases

A ref tracks the current phase:

- **`idle`** — no scrolling. ResizeObserver may call `stickIfNeeded()`.
- **`user`** — user is actively scrolling (touch drag or momentum). `stickIfNeeded()` is blocked. `shouldStick` is updated synchronously per event.
- **`programmatic`** — code called `scrollToBottom()`. User scroll events are ignored until settled.

Transitions:

```
idle ──scroll event──► user ──scrollend──► idle
idle ──scrollToBottom()──► programmatic ──scrollend──► idle
```

### Why No RAF Debouncing

Reading `scrollTop`, `scrollHeight`, `clientHeight` in a passive scroll handler is cheap — the browser has already computed layout for the scroll. The RAF in the current code was a premature optimization that introduced the race condition. Removing it makes `shouldStick` updates synchronous, eliminating the window where ResizeObserver can conflict.

### Behavior Logic (single scroll handler)

On each `scroll` event, the handler runs this sequence:

1. **Read metrics** — `scrollTop`, `scrollHeight`, `clientHeight`, `distanceFromBottom` (computed once, used by all behaviors).
2. **Phase gate** — if `phase === 'programmatic'`, skip all user-driven logic.
3. **Sticky** — if `distanceFromBottom <= threshold`, set `shouldStick = true`. Otherwise set `shouldStick = false`. Synchronous, no RAF.
4. **Hide-on-scroll** — accumulate delta, flip a ref when threshold is crossed, notify parent via callback only on actual change (not React state).
5. **History paging** — if scrolling up and near top and not sticky, call `onNearTop` callback.

On `scrollend`:

1. Finalize sticky state (handles momentum overshoot).
2. Set `phase = 'idle'`.

### ResizeObserver (content growth)

Observes the content wrapper. When height changes:

- If `phase === 'idle'` and `shouldStick === true` → `scrollToBottom('instant')`.
- If `phase === 'user'` → no-op. User is in control.
- If `phase === 'programmatic'` → no-op. Already scrolling.

This is the critical fix: phase-gating prevents resize events from fighting user input.

### API

```typescript
interface ScrollControllerOptions {
  stickyThreshold?: number        // default: 50px
  hideScrollThreshold?: number    // default: 50px
  hideBottomThreshold?: number    // default: 100px
  topLoadThreshold?: number       // default: 1000px
  onHideChange?: (hidden: boolean) => void
  onNearTop?: () => void
}

interface ScrollControllerReturn {
  scrollRef: (el: HTMLDivElement | null) => void
  contentRef: (el: HTMLDivElement | null) => void
  scrollElement: React.RefObject<HTMLDivElement | null>
  shouldStick: React.RefObject<boolean>
  isAtBottom: React.RefObject<boolean>
  scrollToBottom: (behavior?: ScrollBehavior) => void
}
```

### Files Changed

| File | Action |
|------|--------|
| `app/hooks/use-scroll-controller.ts` | **Create** — unified hook |
| `app/hooks/use-stick-to-bottom.ts` | **Delete** — replaced |
| `app/hooks/use-hide-on-scroll.ts` | **Delete** — replaced |
| `app/components/claude/chat/message-list.tsx` | **Update** — use controller, remove history scroll listener |
| `app/components/claude/chat/chat-interface.tsx` | **Update** — remove `useHideOnScroll`, get hide state from controller callback |
