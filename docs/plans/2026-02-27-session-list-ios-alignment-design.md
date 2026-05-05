# Session List Panel — iOS-aligned UX

**Date:** 2026-02-27

## Goal

Align the web session list panel UX with the iOS app: collapsible sidebar, centered filter dropdown, time-based grouping, and native-feeling mobile navigation stack.

## Changes

### 1. Collapsible Sidebar (Desktop)

Replace the current fixed-width `div` layout with `ResizablePanelGroup` + `ResizablePanel` (already installed via `react-resizable-panels`).

- Sidebar panel with `collapsedSize`, `minSize`, `onCollapse` support
- `autoSaveId` for persisting size to localStorage
- Collapse toggle button (`PanelLeftClose` / `PanelLeftOpen` icon) in header
- `ResizableHandle` between panels for drag-to-resize

```
┌──────────────────────────────────┬───┬─────────────────────────────┐
│  [◀] Sessions · Active [▾] [+]  │ ║ │                             │
│──────────────────────────────────│ ║ │                             │
│  Today                           │ ║ │       Chat Area             │
│    Session A              2h     │ ║ │                             │
│    Session B         🟠   5m     │ ║ │                             │
│  Yesterday                       │ ║ │                             │
│    Session C              1d     │ ║ │                             │
│  Past Week                       │   │                             │
│    Session D              3d     │   │                             │
└──────────────────────────────────┴───┴─────────────────────────────┘
```

Collapsed: panel shrinks to 0, chat fills screen. A floating expand button appears.

### 2. Header — Centered Filter Dropdown

Replace separate "Sessions (X)" title + filter dropdown with a single centered `DropdownMenu`:

```
  [◀]    Sessions · Active [▾]    [+]
  left        center              right
```

- **Left:** Collapse toggle button
- **Center:** `DropdownMenu` — click to switch between Active / Archived / All
- **Right:** Existing "New" button (unchanged)

### 3. Time-Based Grouping

Port iOS `groupedSessions` logic. Group by `lastUserActivity` (fallback `lastActivity`):

| Group | Rule |
|-------|------|
| Today | `date >= startOfToday` |
| Yesterday | `date >= startOfYesterday` |
| Past Week | `date >= 7 days ago` |
| Past Month | `date >= 30 days ago` |
| Earlier | Everything else |

Section headers: small, muted text. Empty groups omitted. Non-collapsible (static headers).

### 4. Mobile — Navigation Stack

Replace Sheet overlay with stack navigation:

```
┌─ State: "list" ──────────────┐     ┌─ State: "detail" ─────────────┐
│                               │     │[←]                            │
│  Sessions · Active [▾]   [+] │     │                                │
│───────────────────────────────│     │                                │
│  Today                        │     │      Chat Interface            │
│    Session A            2h    │ ──▶ │      (full screen)             │
│    Session B       🟠   5m    │ tap │                                │
│  Yesterday                    │     │                                │
│    Session C            1d    │ ◀── │                                │
│                               │ back│                                │
└───────────────────────────────┘     └────────────────────────────────┘
```

- **List view:** Full-screen session list with same header (centered filter + New)
- **Detail view:** Full-screen chat, NO title bar — just a floating `←` back button (absolute positioned, top-left, no height taken)
- **Transitions:** Slide-left to enter, slide-right to go back
- **Swipe gesture:** Swipe from left edge to go back (iOS-style)
- **State:** `activeSessionId` — null = list, set = detail

## Components Used

| Component | Source | Purpose |
|-----------|--------|---------|
| `ResizablePanelGroup` / `ResizablePanel` / `ResizableHandle` | shadcn (installed) | Collapsible sidebar |
| `DropdownMenu` | shadcn (installed) | Centered filter selector |
| CSS `.collapsible-grid` | Custom (existing) | Available for section animations |

## Files to Modify

| File | Changes |
|------|---------|
| `frontend/app/routes/claude.tsx` | Layout → ResizablePanelGroup, mobile stack nav, header redesign |
| `frontend/app/components/claude/session-list.tsx` | Add time-based grouping, section headers |
| `frontend/app/globals.css` | Slide transition animations, floating back button styles |

## Out of Scope

- Session row design changes (keep current appearance)
- Session actions (archive, delete, rename — unchanged)
- SSE/real-time updates (unchanged)
- Desktop new-session empty state (unchanged)
