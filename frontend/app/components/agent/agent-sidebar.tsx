/**
 * AgentSidebar — grouped session list for the user-tab path on /agent.
 *
 * Bypasses @assistant-ui/react's ThreadListPrimitive (which is a flat list with
 * no group concept) and renders rows directly. The visual style mirrors the
 * existing ThreadListItem so this drops in as a replacement.
 *
 * Layout:
 *   [Pinned]                         ← virtual section, pinned across all groups
 *     • session
 *   [Group: <name>]    ⠿ [more]      ← drag handle + per-group menu (rename / delete)
 *     • session
 *   [Ungrouped]
 *     • session
 *   [+ Add group]
 *
 * Each section header is collapsible (state persisted in localStorage).
 * "+ Add group" appends an inline empty group at the bottom in rename mode.
 */

import { type FC, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  FolderIcon,
  GripVerticalIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react'
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { Button } from '~/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { Input } from '~/components/ui/input'
import { cn } from '~/lib/utils'
import type { AgentSessionGroup } from '~/lib/agent-groups'

type SessionState = 'idle' | 'working' | 'unread' | 'archived'

export interface SidebarSession {
  id: string
  title: string
  groupId?: string | null
  pinnedAt?: number | null
  source?: 'user' | 'auto'
  agentName?: string
}

export interface AgentSidebarProps {
  sessions: SidebarSession[]
  groups: AgentSessionGroup[]
  activeSessionId?: string | null

  // Per-row maps (parity with ThreadList props)
  sessionStates?: Record<string, SessionState>
  sessionSources?: Record<string, string>
  sessionAgentNames?: Record<string, string>
  sessionTriggerLabels?: Record<string, string>

  // Pagination (last group / ungrouped section's bottom hosts the sentinel)
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void

  // Session-level actions
  onSelectSession: (id: string) => void
  onRenameSession: (id: string, title: string) => Promise<void> | void
  onArchiveSession: (id: string) => Promise<void> | void
  onUnarchiveSession: (id: string) => Promise<void> | void
  onPinSession: (id: string, pinned: boolean) => Promise<void> | void
  onMoveSession: (id: string, groupId: string | null) => Promise<void> | void

  // Group-level actions
  onCreateGroup: (name: string) => Promise<AgentSessionGroup | null>
  onCreateGroupAndMove?: (sessionId: string, name: string) => Promise<void>
  onRenameGroup: (id: string, name: string) => Promise<void> | void
  onDeleteGroup: (id: string) => Promise<void> | void
  onReorderGroups: (ids: string[]) => Promise<void> | void
}

// ── Collapse state (persisted) ────────────────────────────────────────────────

const COLLAPSE_KEY = 'agent-sidebar-collapsed-groups'
// Sentinel keys for the two virtual sections; UUIDs never collide.
const PINNED_KEY = '__pinned__'
const UNGROUPED_KEY = '__ungrouped__'

function loadCollapsed(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, boolean>
  } catch { /* ignore */ }
  return {}
}

function saveCollapsed(state: Record<string, boolean>) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state))
  } catch { /* ignore */ }
}

export const AgentSidebar: FC<AgentSidebarProps> = ({
  sessions,
  groups,
  activeSessionId,
  sessionStates,
  sessionSources,
  sessionAgentNames,
  sessionTriggerLabels,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onSelectSession,
  onRenameSession,
  onArchiveSession,
  onUnarchiveSession,
  onPinSession,
  onMoveSession,
  onCreateGroup,
  onCreateGroupAndMove,
  onRenameGroup,
  onDeleteGroup,
  onReorderGroups,
}) => {
  // Bucket sessions: pinned (across all groups), per-group, ungrouped.
  // A pinned session also appears ONLY in the Pinned section to avoid duplicate rows.
  const { pinned, byGroup, ungrouped } = useMemo(() => {
    const pinned: SidebarSession[] = []
    const byGroup = new Map<string, SidebarSession[]>()
    const ungrouped: SidebarSession[] = []
    for (const s of sessions) {
      if (s.pinnedAt) {
        pinned.push(s)
        continue
      }
      if (s.groupId) {
        const list = byGroup.get(s.groupId) ?? []
        list.push(s)
        byGroup.set(s.groupId, list)
      } else {
        ungrouped.push(s)
      }
    }
    pinned.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0))
    return { pinned, byGroup, ungrouped }
  }, [sessions])

  // Sentinel for infinite-scroll lives at the very bottom of the scroll area.
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !onLoadMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !isLoadingMore) onLoadMore()
      },
      { threshold: 0 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, isLoadingMore, onLoadMore])

  // Drag-to-reorder groups. Local order state is mirrored from `groups` and
  // updated optimistically; the server is told via onReorderGroups.
  const [localGroupOrder, setLocalGroupOrder] = useState<string[]>(() => groups.map((g) => g.id))
  useEffect(() => {
    setLocalGroupOrder(groups.map((g) => g.id))
  }, [groups])
  const orderedGroups = useMemo(() => {
    const lookup = new Map(groups.map((g) => [g.id, g] as const))
    return localGroupOrder.map((id) => lookup.get(id)).filter(Boolean) as AgentSessionGroup[]
  }, [groups, localGroupOrder])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = localGroupOrder.indexOf(String(active.id))
    const newIndex = localGroupOrder.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(localGroupOrder, oldIndex, newIndex)
    setLocalGroupOrder(next)
    void onReorderGroups(next)
  }

  // Collapse state — keyed by group id, plus PINNED_KEY/UNGROUPED_KEY for
  // virtual sections. Persisted to localStorage; default = expanded.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed)
  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      saveCollapsed(next)
      return next
    })
  }

  // Inline draft group — when set, an empty group section renders at the
  // bottom of the list with the rename input active. Submitting creates the
  // group (and, in 'move' mode, moves a session into it).
  const [draftGroup, setDraftGroup] = useState<{ mode: 'add' | 'move'; sessionId?: string } | null>(null)
  const submitDraftGroup = async (name: string) => {
    if (!draftGroup) return
    const trimmed = name.trim()
    if (!trimmed) {
      setDraftGroup(null)
      return
    }
    if (draftGroup.mode === 'move' && draftGroup.sessionId && onCreateGroupAndMove) {
      await onCreateGroupAndMove(draftGroup.sessionId, trimmed)
    } else {
      await onCreateGroup(trimmed)
    }
    setDraftGroup(null)
  }

  // From a session row, "Add group..." opens the inline draft with move-mode.
  const onAddGroupAndMoveFromRow = onCreateGroupAndMove
    ? (sessionId: string) => setDraftGroup({ mode: 'move', sessionId })
    : undefined

  return (
    <div className="aui-root flex flex-1 min-h-0 flex-col gap-0.5 overflow-y-auto">
      {pinned.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <SectionHeader
            title="Pinned"
            collapsed={!!collapsed[PINNED_KEY]}
            onToggle={() => toggleCollapsed(PINNED_KEY)}
          />
          {!collapsed[PINNED_KEY] &&
            pinned.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                groups={groups}
                activeSessionId={activeSessionId}
                sessionStates={sessionStates}
                sessionSources={sessionSources}
                sessionAgentNames={sessionAgentNames}
                sessionTriggerLabels={sessionTriggerLabels}
                onSelectSession={onSelectSession}
                onRenameSession={onRenameSession}
                onArchiveSession={onArchiveSession}
                onUnarchiveSession={onUnarchiveSession}
                onPinSession={onPinSession}
                onMoveSession={onMoveSession}
                onAddGroupAndMove={onAddGroupAndMoveFromRow}
              />
            ))}
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={orderedGroups.map((g) => g.id)} strategy={verticalListSortingStrategy}>
          {orderedGroups.map((g) => (
            <SortableGroupSection
              key={g.id}
              group={g}
              sessions={byGroup.get(g.id) ?? []}
              groups={groups}
              activeSessionId={activeSessionId}
              sessionStates={sessionStates}
              sessionSources={sessionSources}
              sessionAgentNames={sessionAgentNames}
              sessionTriggerLabels={sessionTriggerLabels}
              collapsed={!!collapsed[g.id]}
              onToggleCollapse={() => toggleCollapsed(g.id)}
              onSelectSession={onSelectSession}
              onRenameSession={onRenameSession}
              onArchiveSession={onArchiveSession}
              onUnarchiveSession={onUnarchiveSession}
              onPinSession={onPinSession}
              onMoveSession={onMoveSession}
              onAddGroupAndMove={onAddGroupAndMoveFromRow}
              onRenameGroup={onRenameGroup}
              onDeleteGroup={onDeleteGroup}
            />
          ))}
        </SortableContext>
      </DndContext>

      {ungrouped.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {/* Hide the Ungrouped header when it's the only section — no need
              to label "Ungrouped" if there's nothing else to contrast with. */}
          {(orderedGroups.length > 0 || pinned.length > 0) && (
            <SectionHeader
              title="Ungrouped"
              collapsed={!!collapsed[UNGROUPED_KEY]}
              onToggle={() => toggleCollapsed(UNGROUPED_KEY)}
            />
          )}
          {(!collapsed[UNGROUPED_KEY] || (orderedGroups.length === 0 && pinned.length === 0)) &&
            ungrouped.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                groups={groups}
                activeSessionId={activeSessionId}
                sessionStates={sessionStates}
                sessionSources={sessionSources}
                sessionAgentNames={sessionAgentNames}
                sessionTriggerLabels={sessionTriggerLabels}
                onSelectSession={onSelectSession}
                onRenameSession={onRenameSession}
                onArchiveSession={onArchiveSession}
                onUnarchiveSession={onUnarchiveSession}
                onPinSession={onPinSession}
                onMoveSession={onMoveSession}
                onAddGroupAndMove={onAddGroupAndMoveFromRow}
              />
            ))}
        </div>
      )}

      {/* Inline draft group — appears below all existing sections */}
      {draftGroup && (
        <DraftGroupSection
          onSubmit={submitDraftGroup}
          onCancel={() => setDraftGroup(null)}
        />
      )}

      {/* Bottom: add-group button + scroll sentinel. Hidden while drafting
          to avoid two "Add group" affordances stacked on top of each other. */}
      {!draftGroup && (
        <button
          type="button"
          onClick={() => setDraftGroup({ mode: 'add' })}
          className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors mt-1"
        >
          <PlusIcon className="size-3.5" />
          Add group
        </button>
      )}

      <div ref={sentinelRef} className="shrink-0 h-1" />
      {isLoadingMore && (
        <div className="flex items-center justify-center py-2">
          <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  )
}

// ─── Section header (shared by Pinned, Ungrouped, and groups) ─────────────────
//
// Layout: [drag-slot 20px] [chevron+title button] [menu]. The drag-slot is
// always rendered (even empty) so the title text aligns horizontally across
// section types. Click on the chevron+title toggles collapse.

interface SectionHeaderProps {
  title: string
  collapsed: boolean
  onToggle: () => void
  // Group-only:
  dragHandle?: React.ReactNode
  menu?: React.ReactNode
  renaming?: boolean
  renameInput?: React.ReactNode
}

const SectionHeader: FC<SectionHeaderProps> = ({
  title, collapsed, onToggle, dragHandle, menu, renaming, renameInput,
}) => (
  <div className="group/header flex h-7 items-center gap-1 px-1 text-[11px] font-bold uppercase tracking-wider text-foreground">
    <div className="size-5 shrink-0 flex items-center justify-center">
      {dragHandle ?? null}
    </div>
    {renaming ? (
      <div className="flex flex-1 min-w-0 items-center gap-1">
        <ChevronDownIcon
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            collapsed && '-rotate-90',
          )}
        />
        {renameInput}
      </div>
    ) : (
      <button
        type="button"
        onClick={onToggle}
        className="flex flex-1 min-w-0 items-center gap-1 text-left"
      >
        <ChevronDownIcon
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            collapsed && '-rotate-90',
          )}
        />
        <span className="truncate" title={title}>
          {title}
        </span>
      </button>
    )}
    {menu}
  </div>
)

// ─── Sortable group section ───────────────────────────────────────────────────

interface GroupSectionProps {
  group: AgentSessionGroup
  sessions: SidebarSession[]
  groups: AgentSessionGroup[]
  activeSessionId?: string | null
  sessionStates?: Record<string, SessionState>
  sessionSources?: Record<string, string>
  sessionAgentNames?: Record<string, string>
  sessionTriggerLabels?: Record<string, string>
  collapsed: boolean
  onToggleCollapse: () => void
  onSelectSession: (id: string) => void
  onRenameSession: (id: string, title: string) => Promise<void> | void
  onArchiveSession: (id: string) => Promise<void> | void
  onUnarchiveSession: (id: string) => Promise<void> | void
  onPinSession: (id: string, pinned: boolean) => Promise<void> | void
  onMoveSession: (id: string, groupId: string | null) => Promise<void> | void
  onAddGroupAndMove?: (sessionId: string) => void
  onRenameGroup: (id: string, name: string) => Promise<void> | void
  onDeleteGroup: (id: string) => Promise<void> | void
}

const SortableGroupSection: FC<GroupSectionProps> = (props) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.group.id,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(props.group.name)

  const submitRename = async () => {
    const next = renameValue.trim()
    if (next && next !== props.group.name) {
      await props.onRenameGroup(props.group.id, next)
    }
    setRenaming(false)
  }

  const dragHandle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      className="size-5 cursor-grab opacity-0 group-hover/header:opacity-100 transition-opacity text-muted-foreground hover:text-foreground active:cursor-grabbing flex items-center justify-center"
      aria-label="Drag to reorder group"
    >
      <GripVerticalIcon className="size-3.5" />
    </button>
  )

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="mr-1 size-6 p-0 opacity-0 group-hover/header:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
          <span className="sr-only">Group options</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        <DropdownMenuItem
          onSelect={() => {
            setRenameValue(props.group.name)
            setRenaming(true)
          }}
        >
          <PencilIcon className="size-4" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => setConfirmDelete(true)}
          className="text-destructive focus:text-destructive"
        >
          <Trash2Icon className="size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const renameInput = (
    <Input
      autoFocus
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onBlur={submitRename}
      onKeyDown={(e) => {
        if (e.key === 'Enter') submitRename()
        else if (e.key === 'Escape') {
          setRenameValue(props.group.name)
          setRenaming(false)
        }
      }}
      className="h-6 px-1.5 text-[11px] uppercase tracking-wider font-bold"
    />
  )

  return (
    <div ref={setNodeRef} style={style} className="flex flex-col gap-0.5">
      <SectionHeader
        title={props.group.name}
        collapsed={props.collapsed}
        onToggle={props.onToggleCollapse}
        dragHandle={dragHandle}
        menu={menu}
        renaming={renaming}
        renameInput={renameInput}
      />

      {!props.collapsed && (
        <>
          {props.sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              groups={props.groups}
              activeSessionId={props.activeSessionId}
              sessionStates={props.sessionStates}
              sessionSources={props.sessionSources}
              sessionAgentNames={props.sessionAgentNames}
              sessionTriggerLabels={props.sessionTriggerLabels}
              onSelectSession={props.onSelectSession}
              onRenameSession={props.onRenameSession}
              onArchiveSession={props.onArchiveSession}
              onUnarchiveSession={props.onUnarchiveSession}
              onPinSession={props.onPinSession}
              onMoveSession={props.onMoveSession}
              onAddGroupAndMove={props.onAddGroupAndMove}
            />
          ))}
          {props.sessions.length === 0 && (
            <div className="px-2.5 py-1 text-[11px] text-muted-foreground/60 italic">No sessions</div>
          )}
        </>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group "{props.group.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Sessions in this group will move back to Ungrouped. Sessions are not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                void props.onDeleteGroup(props.group.id)
                setConfirmDelete(false)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── Inline draft group placeholder ───────────────────────────────────────────

const DraftGroupSection: FC<{
  onSubmit: (name: string) => void | Promise<void>
  onCancel: () => void
}> = ({ onSubmit, onCancel }) => {
  const [value, setValue] = useState('')
  const submittedRef = useRef(false)

  // Submit guards against double-fire (Enter + onBlur both reach here when the
  // user presses Enter — Enter triggers submit, then the input loses focus).
  const submit = async () => {
    if (submittedRef.current) return
    submittedRef.current = true
    await onSubmit(value)
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div className="group/header flex h-7 items-center gap-1 px-1 text-[11px] font-bold uppercase tracking-wider text-foreground">
        <div className="size-5 shrink-0" />
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void submit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              submittedRef.current = true
              onCancel()
            }
          }}
          placeholder="New group name"
          className="h-6 flex-1 min-w-0 px-1.5 text-[11px] uppercase tracking-wider font-bold"
        />
      </div>
    </div>
  )
}

// ─── Session row ──────────────────────────────────────────────────────────────

interface SessionRowProps {
  session: SidebarSession
  groups: AgentSessionGroup[]
  activeSessionId?: string | null
  sessionStates?: Record<string, SessionState>
  sessionSources?: Record<string, string>
  sessionAgentNames?: Record<string, string>
  sessionTriggerLabels?: Record<string, string>
  onSelectSession: (id: string) => void
  onRenameSession: (id: string, title: string) => Promise<void> | void
  onArchiveSession: (id: string) => Promise<void> | void
  onUnarchiveSession: (id: string) => Promise<void> | void
  onPinSession: (id: string, pinned: boolean) => Promise<void> | void
  onMoveSession: (id: string, groupId: string | null) => Promise<void> | void
  onAddGroupAndMove?: (sessionId: string) => void
}

const SessionRow: FC<SessionRowProps> = ({
  session,
  groups,
  activeSessionId,
  sessionStates,
  sessionSources,
  sessionAgentNames,
  sessionTriggerLabels,
  onSelectSession,
  onRenameSession,
  onArchiveSession,
  onUnarchiveSession,
  onPinSession,
  onMoveSession,
  onAddGroupAndMove,
}) => {
  const isActive = session.id === activeSessionId
  const sessionState = sessionStates?.[session.id]
  const isArchived = sessionState === 'archived'
  const showDot = !isActive && (sessionState === 'working' || sessionState === 'unread')
  const isAuto = sessionSources?.[session.id] === 'auto' || session.source === 'auto'
  const agentName = sessionAgentNames?.[session.id] ?? session.agentName
  const triggerLabel = sessionTriggerLabels?.[session.id]
  const useAutoLayout = isAuto && !!triggerLabel
  const isPinned = !!session.pinnedAt

  // Inline rename
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(session.title)
  useEffect(() => setRenameValue(session.title), [session.title])

  const submitRename = async () => {
    const next = renameValue.trim()
    if (next && next !== session.title) {
      await onRenameSession(session.id, next)
    }
    setRenaming(false)
  }

  return (
    <div
      {...(isActive ? { 'data-active': 'true' } : {})}
      className="group flex h-8 items-center gap-1 rounded-md transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none data-active:bg-muted"
    >
      {renaming ? (
        <div className="flex h-full min-w-0 flex-1 items-center px-2.5">
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename()
              else if (e.key === 'Escape') {
                setRenameValue(session.title)
                setRenaming(false)
              }
            }}
            className="h-6 px-1.5 text-[13px]"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onSelectSession(session.id)}
          className="flex h-full min-w-0 flex-1 items-center px-2.5 text-start text-[13px]"
        >
          {useAutoLayout ? (
            <>
              {agentName && (
                <span
                  className="shrink-0 text-[10px] leading-none px-1.5 py-0.5 rounded bg-muted text-muted-foreground truncate max-w-[40%] mr-1.5"
                  title={agentName}
                >
                  {agentName}
                </span>
              )}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate group-data-active:text-foreground',
                  isArchived ? 'text-foreground/40' : 'text-foreground/80',
                )}
                title={triggerLabel}
              >
                {triggerLabel}
              </span>
            </>
          ) : (
            <>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate group-data-active:text-foreground',
                  isArchived ? 'text-foreground/40' : 'text-foreground/80',
                )}
              >
                {session.title || 'New Chat'}
              </span>
              {isAuto && agentName && (
                <span
                  className="shrink-0 text-[10px] leading-none px-1.5 py-0.5 rounded bg-muted text-muted-foreground truncate max-w-[40%]"
                  title={agentName}
                >
                  {agentName}
                </span>
              )}
              {isAuto && !agentName && (
                <span className="shrink-0 text-[10px] leading-none px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  auto
                </span>
              )}
            </>
          )}
          <span className="w-2 shrink-0 flex items-center ml-1">
            {isPinned && !showDot && (
              <PinIcon
                className="size-2.5 text-muted-foreground/70"
                aria-label="Pinned"
              />
            )}
            {showDot && (
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  sessionState === 'working' ? 'bg-amber-500' : 'bg-emerald-500',
                )}
                title={sessionState === 'working' ? 'Agent is working' : 'New messages — waiting for you'}
              />
            )}
          </span>
        </button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="mr-1.5 size-6 p-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:bg-accent data-[state=open]:opacity-100 group-data-active:opacity-100"
          >
            <MoreHorizontalIcon className="size-4" />
            <span className="sr-only">Session options</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="min-w-40">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <PencilIcon className="size-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void onPinSession(session.id, !isPinned)}>
            {isPinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
            {isPinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderIcon className="size-4" />
              Move to group
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-44">
              <DropdownMenuItem
                disabled={!session.groupId}
                onSelect={() => void onMoveSession(session.id, null)}
              >
                Ungrouped
              </DropdownMenuItem>
              {groups.length > 0 && <DropdownMenuSeparator />}
              {groups.map((g) => (
                <DropdownMenuItem
                  key={g.id}
                  disabled={g.id === session.groupId}
                  onSelect={() => void onMoveSession(session.id, g.id)}
                >
                  {g.name}
                </DropdownMenuItem>
              ))}
              {onAddGroupAndMove && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onAddGroupAndMove(session.id)}>
                    <PlusIcon className="size-4" />
                    Add group…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />
          {isArchived ? (
            <DropdownMenuItem onSelect={() => void onUnarchiveSession(session.id)}>
              <ArchiveRestoreIcon className="size-4" />
              Unarchive
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void onArchiveSession(session.id)}>
              <ArchiveIcon className="size-4" />
              Archive
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
