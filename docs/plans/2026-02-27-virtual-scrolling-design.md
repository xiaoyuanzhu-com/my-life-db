# Virtual Scrolling for Session Message List

**Date:** 2026-02-27
**Status:** Approved
**Trigger:** WebView process crashes on iOS due to unbounded DOM growth when loading historical message pages.

## Problem

Claude session detail renders inside a WKWebView on iOS. Every loaded message is a real DOM node. When a user scrolls back through history (loading pages of 100 messages), the DOM grows without bound. iOS kills the WebView content process under memory pressure, causing a white-screen crash with a 10-second recovery cooldown.

## Solution

Replace the current "render everything" message list with virtualized rendering using `@tanstack/react-virtual`. Only visible messages plus a small overscan buffer exist in the DOM at any time.

## Library Choice: `@tanstack/react-virtual`

Headless virtualizer hooks from TanStack. Provides the math (which items to render, their offsets) while we own the DOM and scroll logic. Chosen over `react-virtuoso` for more control and smaller bundle (~5KB gzipped).

## Architecture

### Core Setup

The virtualizer lives in `message-list.tsx`, which already owns the scroll container.

**One virtual item = one top-level message.** The virtualizer manages a flat list of `SessionMessage[]`. Each item is measured after render via `measureElement` ref for accurate dynamic heights.

**Nested Task tool messages are NOT separately virtualized.** When a Task tool block contains recursive `SessionMessages` at `depth > 0`, that entire subtree is part of the parent message's measured height. No nested virtualizer complexity.

```tsx
const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => 120,
  measureElement,
  overscan: 5,
})
```

**DOM structure:**

```
<div ref={scrollRef} style={{ overflow: 'auto' }}>
  <div style={{ height: virtualizer.getTotalSize() }}>
    {virtualizer.getVirtualItems().map(vItem => (
      <div ref={measureElement} style={{ transform: translateY(vItem.start) }}>
        <MessageBlock ... />
      </div>
    ))}
  </div>
</div>
```

A 1000-message session renders ~15-25 DOM nodes instead of 1000.

### Stick-to-Bottom

Replaces the `use-stick-to-bottom` library.

- Track `isAtBottom` flag: `true` when `scrollTop + clientHeight >= scrollHeight - 50px`
- Update on scroll events
- When `isAtBottom` and message list grows (new message, streaming delta): `virtualizer.scrollToIndex(count - 1, { align: 'end', behavior: 'smooth' })`
- When user scrolls up, `isAtBottom` becomes `false` — auto-scroll disengages
- Show "scroll to bottom" button when not at bottom (existing UX)

**Streaming text deltas:** The last message's height changes every 40ms. Re-measure the last item on each update. If `isAtBottom`, scroll to end after resize.

### Scroll-Up Pagination (Prepending Older Messages)

When items are prepended to the array, all existing indices shift. Without adjustment, the viewport jumps.

**Offset-based stability:**

```tsx
const prevCount = useRef(messages.length)
useLayoutEffect(() => {
  const added = messages.length - prevCount.current
  if (added > 0 && prependedRef.current) {
    const offset = virtualizer.getVirtualItems()
      .slice(0, added)
      .reduce((sum, item) => sum + item.size, 0)
    scrollRef.current.scrollTop += offset
    prependedRef.current = false
  }
  prevCount.current = messages.length
}, [messages.length])
```

Pagination trigger moves from raw `scrollTop < 300px` to checking the virtualizer's visible range against the first loaded index.

### Dynamic Heights — Collapsible Sections

When thinking blocks, tool results, or Task conversations expand/collapse, item height changes.

**Approach:** Pass `onHeightChange` callback down to collapsible components. After the CSS grid transition completes (200ms), bubble up to re-measure:

```tsx
onHeightChange?.()
// Which calls:
virtualizer.measureElement(itemRef.current)
```

For nested Task tools: expanding a nested conversation changes the parent message's height. `onHeightChange` bubbles up to the top-level message's `measureElement` call.

## Change Scope

| Component | Scope | Description |
|-----------|-------|-------------|
| `message-list.tsx` | **Major rewrite** | Add `useVirtualizer`, replace scroll handling, replace `use-stick-to-bottom` |
| `session-messages.tsx` | **Moderate** | Receive virtual item range, render only visible items, pass `measureElement` refs |
| `message-block.tsx` | **Minor** | Accept `onHeightChange` callback, pass to collapsible children |
| `chat-interface.tsx` | **Minor** | Pagination trigger wiring adjustment |
| Collapsible components | **Minor** | Call `onHeightChange` after expand/collapse transition |
| `use-stick-to-bottom` | **Removed** | Replaced by virtualizer-based stick-to-bottom |

## Key Risks

1. **Prepend scroll stability** — Most error-prone part. May need iteration to eliminate frame-jump on page load.
2. **Streaming re-measurement** — High-frequency height changes during streaming. Must avoid layout thrashing.
3. **Collapsible timing** — Re-measuring before CSS transition completes gives wrong height. Need `transitionend` or debounce.
4. **Overscan tuning** — Too low = visible pop-in on fast scroll. Too high = defeats the purpose. Start at 5, tune on device.

## Success Criteria

- WebView process no longer crashes on iOS when scrolling through long sessions
- Stick-to-bottom behavior identical to current UX
- Scroll-up pagination works without visible jumps
- Collapsible sections expand/collapse without layout glitches
- No regression in streaming text rendering smoothness
