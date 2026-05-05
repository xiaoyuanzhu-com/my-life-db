# Session List iOS Alignment — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align the web session list panel UX with the iOS app — collapsible sidebar, centered filter dropdown, time-based grouping, and mobile navigation stack.

**Architecture:** Four independent changes applied incrementally: (1) time-based grouping in SessionList, (2) centered header dropdown in ClaudePage, (3) resizable/collapsible sidebar replacing fixed div, (4) mobile stack navigation replacing Sheet overlay. Each task is independently verifiable.

**Tech Stack:** React, shadcn/ui (`ResizablePanelGroup`, `DropdownMenu`), `react-resizable-panels`, Tailwind CSS, lucide-react icons.

**Design doc:** `docs/plans/2026-02-27-session-list-ios-alignment-design.md`

**No frontend tests exist in this project.** Each task uses manual browser verification instead.

---

### Task 1: Time-Based Grouping in SessionList

Add iOS-style time grouping (Today, Yesterday, Past Week, Past Month, Earlier) to the session list.

**Files:**
- Modify: `frontend/app/components/claude/session-list.tsx`

**Step 1: Add `groupSessionsByTime` utility function**

Insert after the `formatRelativeTime` function (after line 71), before the `UnreadIndicator` component:

```tsx
// ─── Time-based grouping (ported from iOS ClaudeSessionListView) ─────────────

interface SessionGroup {
  title: string
  sessions: Session[]
}

function groupSessionsByTime(sessions: Session[]): SessionGroup[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000)
  const startOfWeek = new Date(startOfToday.getTime() - 7 * 86400000)
  const startOfMonth = new Date(startOfToday.getTime() - 30 * 86400000)

  const today: Session[] = []
  const yesterday: Session[] = []
  const pastWeek: Session[] = []
  const pastMonth: Session[] = []
  const earlier: Session[] = []

  for (const session of sessions) {
    const date = new Date(session.lastUserActivity || session.lastActivity)
    if (date >= startOfToday) {
      today.push(session)
    } else if (date >= startOfYesterday) {
      yesterday.push(session)
    } else if (date >= startOfWeek) {
      pastWeek.push(session)
    } else if (date >= startOfMonth) {
      pastMonth.push(session)
    } else {
      earlier.push(session)
    }
  }

  const result: SessionGroup[] = []
  if (today.length > 0) result.push({ title: 'Today', sessions: today })
  if (yesterday.length > 0) result.push({ title: 'Yesterday', sessions: yesterday })
  if (pastWeek.length > 0) result.push({ title: 'Past Week', sessions: pastWeek })
  if (pastMonth.length > 0) result.push({ title: 'Past Month', sessions: pastMonth })
  if (earlier.length > 0) result.push({ title: 'Earlier', sessions: earlier })
  return result
}
```

**Step 2: Update SessionList render to use grouped sections**

Replace the flat `sessions.map(...)` block (lines 163-277) with grouped rendering. The current code at lines 162-297 is:

```tsx
// CURRENT (replace this entire block):
        <>
          {sessions.map((session) => {
            // ... session row rendering ...
          })}
          {/* Load more trigger */}
          <div ref={loadMoreTriggerRef} className="h-1" />
          {/* Loading indicator */}
          {/* End of list */}
        </>
```

Replace with:

```tsx
        <>
          {groupSessionsByTime(sessions).map((group) => (
            <div key={group.title}>
              {/* Section header */}
              <div className="sticky top-0 z-10 bg-muted/60 backdrop-blur-sm px-3 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border">
                {group.title}
              </div>
              {group.sessions.map((session) => {
                const { sessionState } = session
                const showDot = (sessionState === 'working' || sessionState === 'unread')
                  && activeSessionId !== session.id

                return (
                  <div
                    key={session.id}
                    className={cn(
                      'group relative border-b border-border p-3 cursor-pointer transition-colors',
                      activeSessionId === session.id
                        ? 'bg-primary/10'
                        : 'hover:bg-muted/50'
                    )}
                    onClick={() => onSelect(session.id)}
                  >
                    {editingId === session.id ? (
                      <div className="flex items-center gap-1">
                        <Input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit()
                            if (e.key === 'Escape') cancelEdit()
                          }}
                          className="h-7 text-sm"
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation()
                            saveEdit()
                          }}
                        >
                          <Check className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation()
                            cancelEdit()
                          }}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <h3
                                className={cn(
                                  'truncate text-sm font-medium text-foreground',
                                  sessionState === 'archived' && 'opacity-60'
                                )}
                                title={getSessionDisplayTitle(session).full}
                              >
                                {getSessionDisplayTitle(session).display}
                              </h3>
                              <span className="w-2 shrink-0 flex items-center">
                                {showDot && (
                                  <UnreadIndicator state={sessionState as 'working' | 'unread'} />
                                )}
                              </span>
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                              <span className="truncate">
                                {session.workingDir}
                              </span>
                              <span className="shrink-0">
                                • {formatRelativeTime(session.lastUserActivity || session.lastActivity)}
                              </span>
                              {session.messageCount !== undefined && session.messageCount > 0 && (
                                <span className="shrink-0">
                                  • {session.messageCount} msgs
                                </span>
                              )}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 transition-opacity"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (sessionState === 'archived') {
                                onUnarchive(session.id)
                              } else {
                                onArchive(session.id)
                              }
                            }}
                            title={sessionState === 'archived' ? 'Unarchive session' : 'Archive session'}
                          >
                            {sessionState === 'archived' ? (
                              <ArchiveRestore className="h-3.5 w-3.5" />
                            ) : (
                              <Archive className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          ))}

          {/* Load more trigger element */}
          <div ref={loadMoreTriggerRef} className="h-1" />

          {/* Loading indicator */}
          {isLoadingMore && (
            <div className="flex items-center justify-center p-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span className="text-sm">Loading more...</span>
            </div>
          )}

          {/* End of list indicator */}
          {!hasMore && sessions.length > 0 && (
            <div className="p-3 text-center text-xs text-muted-foreground">
              — End of sessions —
            </div>
          )}
        </>
```

**Step 3: Verify in browser**

Run: `cd <worktree> && npm run dev` (from the frontend directory)
Expected: Session list shows grouped headers (Today, Yesterday, etc.). Sticky headers stay visible while scrolling within a group. Empty groups are omitted. Session rows look identical to before.

**Step 4: Commit**

```bash
git add frontend/app/components/claude/session-list.tsx
git commit -m "feat(claude): add iOS-style time-based grouping to session list"
```

---

### Task 2: Centered Header with DropdownMenu Filter

Replace the separate "Sessions" title + Select dropdown with a single centered DropdownMenu, plus collapse toggle on the left.

**Files:**
- Modify: `frontend/app/routes/claude.tsx`

**Step 1: Update imports**

Replace the Select imports (lines 11-17) and add DropdownMenu + new icons:

```tsx
// REMOVE these lines (11-17):
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'

// ADD in their place:
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
```

Also update the lucide-react import (line 9):

```tsx
// CHANGE from:
import { Plus, Menu } from 'lucide-react'

// TO:
import { Plus, PanelLeftClose, PanelLeftOpen, ChevronDown, ArrowLeft } from 'lucide-react'
```

**Step 2: Add sidebar collapse state**

Inside `ClaudePage()` function, after `const [isLoadingMore, setIsLoadingMore]` (line 74), add:

```tsx
  // Sidebar collapse state (desktop)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('claude-sidebar-collapsed') === 'true'
    }
    return false
  })
```

And add a persist effect after the existing persist effects (after line 132):

```tsx
  // Persist sidebar collapsed state
  useEffect(() => {
    localStorage.setItem('claude-sidebar-collapsed', String(isSidebarCollapsed))
  }, [isSidebarCollapsed])
```

**Step 3: Create a reusable `SessionsHeader` component**

Add this as a local component inside `claude.tsx`, before the `return` statement (before line 533). This is used by both desktop sidebar and mobile list view:

```tsx
  // ─── Shared header for desktop sidebar and mobile list view ────────────────
  const SessionsHeader = ({ showCollapseButton = false }: { showCollapseButton?: boolean }) => (
    <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
      {/* Left: collapse toggle (desktop only) */}
      <div className="w-8 flex items-center">
        {showCollapseButton && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setIsSidebarCollapsed(true)}
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Center: filter dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-1.5 text-sm font-semibold hover:text-primary transition-colors px-2 py-1 rounded-md hover:bg-muted/50">
            Sessions · {statusFilter === 'active' ? 'Active' : statusFilter === 'archived' ? 'Archived' : 'All'}
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          <DropdownMenuRadioGroup value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
            <DropdownMenuRadioItem value="active">Active</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="archived">Archived</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Right: new button */}
      <div className="w-8 flex items-center justify-end">
        {sessionCreateNew && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setActiveSessionId(null)}
            title="New session"
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
```

**Step 4: Verify in browser**

Run dev server, check desktop sidebar header shows centered "Sessions · Active" with dropdown. Collapse button on left, + on right. Filter switching works.

**Step 5: Commit**

```bash
git add frontend/app/routes/claude.tsx
git commit -m "feat(claude): centered filter dropdown header with collapse button"
```

---

### Task 3: Collapsible Sidebar with ResizablePanelGroup

Replace the fixed-width `div` sidebar layout with `ResizablePanelGroup` for resize + collapse.

**Files:**
- Modify: `frontend/app/routes/claude.tsx`

**Step 1: Add ResizablePanel imports**

Add to imports at top of file:

```tsx
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '~/components/ui/resizable'
```

Also add the `useRef` import for the panel ref (already imported on line 1 — no change needed).

Add `type ImperativePanelHandle` import:

```tsx
import type { ImperativePanelHandle } from 'react-resizable-panels'
```

**Step 2: Add panel ref**

After the `isSidebarCollapsed` state (added in Task 2), add:

```tsx
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null)
```

And add an effect to sync collapse state with the panel:

```tsx
  // Sync sidebar panel with collapse state
  useEffect(() => {
    const panel = sidebarPanelRef.current
    if (!panel) return
    if (isSidebarCollapsed) {
      panel.collapse()
    } else {
      panel.expand()
    }
  }, [isSidebarCollapsed])
```

**Step 3: Replace the desktop layout**

Replace the entire return block (lines 533-705). The new return:

```tsx
  return (
    <div className="flex h-full">
      {/* ── Desktop: Resizable sidebar + chat ── */}
      <div className="hidden md:flex md:flex-1 h-full">
        {sessionSidebar ? (
          <ResizablePanelGroup
            direction="horizontal"
            autoSaveId="claude-sidebar"
          >
            {/* Sidebar panel */}
            <ResizablePanel
              ref={sidebarPanelRef}
              defaultSize={30}
              minSize={20}
              maxSize={50}
              collapsible
              collapsedSize={0}
              onCollapse={() => setIsSidebarCollapsed(true)}
              onExpand={() => setIsSidebarCollapsed(false)}
              className={cn(
                'flex flex-col bg-muted/30',
                isSidebarCollapsed && 'hidden'
              )}
            >
              <SessionsHeader showCollapseButton />
              <div className="flex-1 overflow-hidden">
                <SessionList
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  onSelect={handleSelectSession}
                  onDelete={deleteSession}
                  onRename={updateSessionTitle}
                  onArchive={archiveSession}
                  onUnarchive={unarchiveSession}
                  hasMore={pagination.hasMore}
                  isLoadingMore={isLoadingMore}
                  onLoadMore={loadMoreSessions}
                />
              </div>
            </ResizablePanel>

            {/* Resize handle (hidden when collapsed) */}
            {!isSidebarCollapsed && <ResizableHandle />}

            {/* Main content panel */}
            <ResizablePanel defaultSize={70} minSize={40}>
              <div className="relative flex flex-1 flex-col bg-background overflow-hidden min-w-0 h-full">
                {/* Expand button when sidebar is collapsed */}
                {isSidebarCollapsed && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-2 left-2 z-20 h-8 w-8"
                    onClick={() => setIsSidebarCollapsed(false)}
                    title="Expand sidebar"
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                  </Button>
                )}
                {activeSessionId ? (
                  <ChatInterface
                    key={activeSessionId}
                    sessionId={activeSessionId}
                    sessionName={effectiveActiveSession?.title || 'Session'}
                    workingDir={effectiveActiveSession?.workingDir}
                    permissionMode={effectiveActiveSession?.permissionMode}
                    onSessionNameChange={(name) => updateSessionTitle(activeSessionId, name)}
                    refreshSessions={refreshSessions}
                    initialMessage={pendingInitialMessage ?? undefined}
                    onInitialMessageSent={() => setPendingInitialMessage(null)}
                  />
                ) : (
                  <div className="flex flex-1 flex-col claude-bg">
                    <div className="flex-1" />
                    <ChatInput
                      onSend={createSessionWithMessage}
                      disabled={isCreatingSession}
                      placeholder="Start a new conversation..."
                      workingDir={newSessionWorkingDir}
                      onWorkingDirChange={setNewSessionWorkingDir}
                      slashCommands={warmSlashCommands.length > BUILTIN_COMMANDS.length
                        ? warmSlashCommands
                        : BUILTIN_COMMANDS}
                      permissionMode={newSessionPermissionMode}
                      onPermissionModeChange={setNewSessionPermissionMode}
                    />
                  </div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          /* No sidebar — just the chat area */
          <div className="flex-1 flex flex-col bg-background overflow-hidden min-w-0">
            {activeSessionId ? (
              <ChatInterface
                key={activeSessionId}
                sessionId={activeSessionId}
                sessionName={effectiveActiveSession?.title || 'Session'}
                workingDir={effectiveActiveSession?.workingDir}
                permissionMode={effectiveActiveSession?.permissionMode}
                onSessionNameChange={(name) => updateSessionTitle(activeSessionId, name)}
                refreshSessions={refreshSessions}
                initialMessage={pendingInitialMessage ?? undefined}
                onInitialMessageSent={() => setPendingInitialMessage(null)}
              />
            ) : (
              <div className="flex flex-1 flex-col claude-bg">
                <div className="flex-1" />
                <ChatInput
                  onSend={createSessionWithMessage}
                  disabled={isCreatingSession}
                  placeholder="Start a new conversation..."
                  workingDir={newSessionWorkingDir}
                  onWorkingDirChange={setNewSessionWorkingDir}
                  slashCommands={warmSlashCommands.length > BUILTIN_COMMANDS.length
                    ? warmSlashCommands
                    : BUILTIN_COMMANDS}
                  permissionMode={newSessionPermissionMode}
                  onPermissionModeChange={setNewSessionPermissionMode}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Mobile: Stack navigation ── */}
      <div className="flex md:hidden flex-1 h-full">
        {activeSessionId ? (
          /* Detail view: full-screen chat with floating back button */
          <div className="relative flex flex-1 flex-col bg-background overflow-hidden min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 left-2 z-20 h-10 w-10 rounded-full bg-background/80 backdrop-blur"
              onClick={() => setActiveSessionId(null)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <ChatInterface
              key={activeSessionId}
              sessionId={activeSessionId}
              sessionName={effectiveActiveSession?.title || 'Session'}
              workingDir={effectiveActiveSession?.workingDir}
              permissionMode={effectiveActiveSession?.permissionMode}
              onSessionNameChange={(name) => updateSessionTitle(activeSessionId, name)}
              refreshSessions={refreshSessions}
              initialMessage={pendingInitialMessage ?? undefined}
              onInitialMessageSent={() => setPendingInitialMessage(null)}
            />
          </div>
        ) : (
          /* List view: full-screen session list */
          <div className="flex flex-1 flex-col bg-muted/30">
            <SessionsHeader />
            <div className="flex-1 overflow-hidden">
              <SessionList
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelect={handleSelectSession}
                onDelete={deleteSession}
                onRename={updateSessionTitle}
                onArchive={archiveSession}
                onUnarchive={unarchiveSession}
                hasMore={pagination.hasMore}
                isLoadingMore={isLoadingMore}
                onLoadMore={loadMoreSessions}
              />
            </div>
            {/* New session input at bottom of list view */}
            {sessionCreateNew && !activeSessionId && (
              <div className="border-t border-border">
                <ChatInput
                  onSend={createSessionWithMessage}
                  disabled={isCreatingSession}
                  placeholder="Start a new conversation..."
                  workingDir={newSessionWorkingDir}
                  onWorkingDirChange={setNewSessionWorkingDir}
                  slashCommands={warmSlashCommands.length > BUILTIN_COMMANDS.length
                    ? warmSlashCommands
                    : BUILTIN_COMMANDS}
                  permissionMode={newSessionPermissionMode}
                  onPermissionModeChange={setNewSessionPermissionMode}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
```

**Step 4: Remove old mobile sidebar code**

The old Sheet-based mobile sidebar (former lines 591-642) and mobile action buttons (former lines 644-668) are no longer needed — they are replaced by the mobile stack navigation above. Remove:

- The `showMobileSidebar` state (line 54) — no longer used
- The Sheet import (line 10) — no longer used
- The `Menu` import from lucide — no longer used
- The `Select` import was already removed in Task 2

**Step 5: Update swipe gesture to clear activeSessionId instead of navigate(-1)**

The existing swipe gesture (lines 272-322) uses `navigate(-1)` which relies on browser history. Update to use `setActiveSessionId(null)` for cleaner behavior. Change the `handleTouchEnd` logic:

```tsx
    // In handleTouchEnd (around line 298):
    // CHANGE from:
    if (touchStartX.current > 0 && touchStartX.current - touchEndX.current > 100) {
      navigate(-1)
    }
    // Note: the condition is wrong — swipe RIGHT means endX > startX
    // FIX to:
    if (touchStartX.current > 0 && touchEndX.current - touchStartX.current > 100) {
      setActiveSessionId(null)
    }
```

Also update the effect to only run when there's an active session on mobile:

```tsx
    // Only add listeners on mobile when viewing a session detail
    const isMobile = window.innerWidth < 768
    if (isMobile && activeSessionId) {
      // ... add listeners
    }
```

**Step 6: Verify in browser**

Desktop: Sidebar resizable by dragging the handle. Collapse button hides sidebar, expand button brings it back. Panel size persists across page loads.

Mobile (use Chrome DevTools responsive mode): Session list shows full-screen. Tap session → full-screen chat with floating ← button. Tap ← → back to list. Swipe from left edge → back to list.

**Step 7: Commit**

```bash
git add frontend/app/routes/claude.tsx
git commit -m "feat(claude): collapsible resizable sidebar + mobile stack navigation"
```

---

### Task 4: CSS for Mobile Slide Transitions (Optional Polish)

Add slide animations for the mobile list↔detail transitions.

**Files:**
- Modify: `frontend/app/globals.css`
- Modify: `frontend/app/routes/claude.tsx` (add animation classes)

**Step 1: Add slide transition keyframes to globals.css**

After the `.collapsible-grid-content` block (after line 274), add:

```css
/* Mobile stack navigation transitions */
@keyframes slide-in-right {
  from {
    transform: translateX(100%);
  }
  to {
    transform: translateX(0);
  }
}

@keyframes slide-in-left {
  from {
    transform: translateX(-30%);
    opacity: 0.5;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.animate-slide-in-right {
  animation: slide-in-right 0.3s ease-out;
}

.animate-slide-in-left {
  animation: slide-in-left 0.3s ease-out;
}
```

**Step 2: Apply animation classes in claude.tsx**

In the mobile section, add the animation class to the detail view wrapper:

```tsx
// On the detail view div:
<div className="relative flex flex-1 flex-col bg-background overflow-hidden min-w-0 animate-slide-in-right">
```

**Step 3: Verify in browser**

Mobile: Tapping a session slides in from the right. Going back slides in from the left. The animations are smooth and quick (0.3s).

**Step 4: Commit**

```bash
git add frontend/app/globals.css frontend/app/routes/claude.tsx
git commit -m "feat(claude): add slide transition animations for mobile stack nav"
```

---

### Task 5: Clean Up Unused Imports and Dead Code

Remove any leftover unused imports/state from the old implementation.

**Files:**
- Modify: `frontend/app/routes/claude.tsx`

**Step 1: Audit imports and state**

Remove these if unused after the changes:
- `Sheet, SheetContent, SheetHeader, SheetTitle` import (line 10) — replaced by stack nav
- `Select, SelectContent, SelectItem, SelectTrigger, SelectValue` — replaced by DropdownMenu (already done in Task 2)
- `Menu` from lucide-react — no longer needed (mobile menu button removed)
- `showMobileSidebar` / `setShowMobileSidebar` state — no longer needed

Verify no TypeScript errors:

Run: `cd <worktree>/frontend && npx tsc --noEmit`
Expected: No errors

**Step 2: Commit**

```bash
git add frontend/app/routes/claude.tsx
git commit -m "chore(claude): remove unused sheet/select imports after sidebar refactor"
```
