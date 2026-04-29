/**
 * AgentSidebar — grouped session list for the user-tab path on /agent.
 *
 * Bypasses @assistant-ui/react's ThreadListPrimitive (which is a flat list with
 * no group concept) and renders rows directly. The visual style mirrors the
 * existing ThreadListItem so this drops in as a replacement.
 *
 * Layout:
 *   [Pinned]                         ← virtual section, pinned sessions across all groups
 *     • session
 *   [Group: <name>]    ⠿ [more]      ← drag handle + per-group menu (rename / delete)
 *     • session
 *   [Ungrouped]
 *     • session
 *   [+ Add group]
 */

import { type FC, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
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

  // "Add group" inline dialog
  const [showAddGroup, setShowAddGroup] = useState(false)

  return (
    <div className="aui-root flex flex-1 min-h-0 flex-col gap-0.5 overflow-y-auto">
      {pinned.length > 0 && (
        <Section title="Pinned">
          {pinned.map((s) => (
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
              onCreateGroupAndMove={onCreateGroupAndMove}
            />
          ))}
        </Section>
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
              onSelectSession={onSelectSession}
              onRenameSession={onRenameSession}
              onArchiveSession={onArchiveSession}
              onUnarchiveSession={onUnarchiveSession}
              onPinSession={onPinSession}
              onMoveSession={onMoveSession}
              onCreateGroupAndMove={onCreateGroupAndMove}
              onRenameGroup={onRenameGroup}
              onDeleteGroup={onDeleteGroup}
            />
          ))}
        </SortableContext>
      </DndContext>

      {ungrouped.length > 0 && (
        <Section title={orderedGroups.length > 0 || pinned.length > 0 ? 'Ungrouped' : null}>
          {ungrouped.map((s) => (
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
              onCreateGroupAndMove={onCreateGroupAndMove}
            />
          ))}
        </Section>
      )}

      {/* Bottom: add-group button + scroll sentinel */}
      <button
        type="button"
        onClick={() => setShowAddGroup(true)}
        className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors mt-1"
      >
        <PlusIcon className="size-3.5" />
        Add group
      </button>

      <div ref={sentinelRef} className="shrink-0 h-1" />
      {isLoadingMore && (
        <div className="flex items-center justify-center py-2">
          <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}

      <AddGroupDialog open={showAddGroup} onOpenChange={setShowAddGroup} onCreate={onCreateGroup} />
    </div>
  )
}

// ─── Section header (non-sortable; used for Pinned + Ungrouped) ───────────────

const Section: FC<{ title: string | null; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex flex-col gap-0.5">
    {title != null && (
      <div className="flex h-6 items-center px-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {title}
      </div>
    )}
    {children}
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
  onSelectSession: (id: string) => void
  onRenameSession: (id: string, title: string) => Promise<void> | void
  onArchiveSession: (id: string) => Promise<void> | void
  onUnarchiveSession: (id: string) => Promise<void> | void
  onPinSession: (id: string, pinned: boolean) => Promise<void> | void
  onMoveSession: (id: string, groupId: string | null) => Promise<void> | void
  onCreateGroupAndMove?: (sessionId: string, name: string) => Promise<void>
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

  return (
    <div ref={setNodeRef} style={style} className="flex flex-col gap-0.5">
      <div className="group/header flex h-7 items-center gap-1 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="size-5 shrink-0 cursor-grab opacity-0 group-hover/header:opacity-100 transition-opacity text-muted-foreground hover:text-foreground active:cursor-grabbing flex items-center justify-center"
          aria-label="Drag to reorder group"
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        {renaming ? (
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
            className="h-6 px-1.5 text-[11px] uppercase tracking-wider"
          />
        ) : (
          <span className="flex-1 truncate" title={props.group.name}>
            {props.group.name}
          </span>
        )}
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
      </div>

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
          onCreateGroupAndMove={props.onCreateGroupAndMove}
        />
      ))}
      {props.sessions.length === 0 && (
        <div className="px-2.5 py-1 text-[11px] text-muted-foreground/60 italic">No sessions</div>
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
  onCreateGroupAndMove?: (sessionId: string, name: string) => Promise<void>
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
  onCreateGroupAndMove,
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

  // "Add group" from within the move-to submenu
  const [showAddGroupForMove, setShowAddGroupForMove] = useState(false)

  return (
    <>
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
                <ChevronRightIcon className="ml-auto size-4" />
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
                {onCreateGroupAndMove && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setShowAddGroupForMove(true)}>
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

      {onCreateGroupAndMove && (
        <AddGroupDialog
          open={showAddGroupForMove}
          onOpenChange={setShowAddGroupForMove}
          onCreate={async (name) => {
            await onCreateGroupAndMove(session.id, name)
            return null
          }}
        />
      )}
    </>
  )
}

// ─── Add-group dialog ─────────────────────────────────────────────────────────

const AddGroupDialog: FC<{
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreate: (name: string) => Promise<AgentSessionGroup | null>
}> = ({ open, onOpenChange, onCreate }) => {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) setName('')
  }, [open])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      await onCreate(trimmed)
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add group</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="Group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim() || submitting}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
