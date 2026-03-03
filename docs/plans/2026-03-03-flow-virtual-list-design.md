# Flow-Based Virtual List — Replace @tanstack/react-virtual

**Date:** 2026-03-03
**Status:** Implemented

## Problem

The session detail page's scroll experience is unreliable. Virtual scrolling (via `@tanstack/react-virtual`) and stick-to-bottom fight each other, causing scroll jumps — especially on mobile.

**Root cause:** @tanstack/react-virtual uses absolute positioning with computed cumulative offsets. When items resize (collapsibles, streaming content), the library must adjust `scrollTop` to keep the viewport stable. This scroll adjustment conflicts with the custom `useScrollController`'s stick-to-bottom and mobile touch tracking, creating a two-system coordination problem mediated through `shouldAdjustScrollPositionOnItemSizeChange` — a reactive veto callback that fires after the library has already committed to an adjustment.

## Design Principle

**The virtualizer never touches scroll position.** It only controls which items are in the DOM. All scroll behavior is owned by the browser (scroll anchoring) and the existing `useScrollController` (stick-to-bottom, hide-on-scroll, history paging).

## Architecture

Replace tanstack's absolute-positioning model with flow-based layout + browser scroll anchoring:

```
scroll container (overflow-anchor: auto — browser default)
  ├── top spacer div       ← height: estimateSize × startIndex
  ├── item (normal flow)   ← rendered messages, anchor candidates
  ├── item (normal flow)
  ├── ...
  ├── bottom spacer div    ← height: estimateSize × remainingCount
  ├── streaming/wip        ← overflow-anchor: none (not anchor candidates)
```

**Items are in normal document flow** — no `position: absolute`, no `translateY`, no cumulative offset calculation. The browser handles layout. The virtualizer only decides which items to render.

**Browser `overflow-anchor: auto`** handles scroll position stability when items resize. When an item above the viewport grows/shrinks, the browser adjusts `scrollTop` automatically — no JavaScript needed.

### What was removed

- `@tanstack/react-virtual` dependency
- `shouldAdjustScrollPositionOnItemSizeChange` callback
- Per-item `measureElement` ResizeObserver
- Absolute positioning container with `translateY` per item
- Manual scroll position restoration on prepend (`useLayoutEffect` with `virtualizer.scrollToOffset`)

### What was added

- `useVirtualList` hook (~150 lines) — pure range calculation from `scrollTop` / `estimateSize`
- Top/bottom spacer divs with `overflowAnchor: 'none'`
- `overflowAnchor: 'none'` on all non-message elements (loading spinner, streaming, WIP)

### What stayed unchanged

- `useScrollController` — zero changes
- `MessageBlock` — zero changes
- `useFilteredMessages` — zero changes
- `session-messages.tsx` (nested depth > 0) — zero changes

## Key Decisions

### No height measurement/caching

The hook uses `estimateSize` (120px) for all range and spacer calculations. No ResizeObserver on individual items. Trade-off: scrollbar thumb position is approximate. Acceptable for a chat interface.

### Generous overscan (10 → 1200px buffer)

Increased from tanstack's 5 to compensate for height variance without measurement. With 120px estimate and 10 overscan, there's 1200px buffer above and below the viewport. Covers items up to ~4x the estimated height without visible blanks during normal scrolling.

### Browser scroll anchoring instead of manual adjustment

`overflowAnchor: 'none'` was explicitly set on the scroll container before (to prevent conflicts with tanstack's manual adjustments). Now removed to enable the browser default `auto`. Non-message elements (spacers, streaming, loading) are marked `overflowAnchor: 'none'` so only actual message elements serve as anchors.

### Prepend handled by range shift + browser anchoring

When older messages prepend, the `useVirtualList` hook detects the first-key change and shifts the rendered range in `useLayoutEffect` (synchronous, before paint). The same message DOM nodes stay rendered; only the spacer heights change. Browser scroll anchoring keeps the viewport stable.

## Browser Support

`overflow-anchor` is supported in Chrome 56+, Firefox 66+, Edge 79+, Safari 17.4+. For older Safari, scroll anchoring degrades gracefully — items render correctly but scroll position may shift slightly on resize. This is the same class of issue that tanstack had, but less severe since there's no absolute positioning fighting it.

## Files Changed

| File | Change |
|------|--------|
| `frontend/app/hooks/use-virtual-list.ts` | New — flow-based virtual list hook |
| `frontend/app/components/claude/chat/message-list.tsx` | Replace tanstack with new hook, flow layout |
| `frontend/package.json` | Remove `@tanstack/react-virtual` |
