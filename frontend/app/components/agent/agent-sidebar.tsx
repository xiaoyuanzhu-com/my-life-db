/**
 * AgentSidebar — flat session list with pin-on-top and time-based sections.
 *
 * Bypasses @assistant-ui/react's ThreadListPrimitive (which is a flat list with
 * no section concept) and renders rows directly. The visual style mirrors the
 * existing ThreadListItem so this drops in as a replacement.
 *
 * Layout:
 *   Pinned          ← virtual section, only when there are pinned sessions
 *     • session
 *   Today           ← time-based buckets, only rendered when non-empty
 *     • session
 *   Yesterday
 *     • session
 *   Last 7 days
 *     • session
 *   Last 30 days
 *     • session
 *   Earlier
 *     • session
 *
 * Backend group metadata is intentionally ignored here; sessions still carry
 * groupId from the API but the sidebar no longer surfaces it.
 */

import { type FC, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
} from 'lucide-react'

import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { Input } from '~/components/ui/input'
import { cn } from '~/lib/utils'

type SessionState = 'idle' | 'working' | 'unread' | 'archived'

export interface SidebarSession {
  id: string
  title: string
  lastActivity: number
  pinnedAt?: number | null
  source?: 'user' | 'auto'
  agentName?: string
}

export interface AgentSidebarProps {
  sessions: SidebarSession[]
  activeSessionId?: string | null

  // Per-row maps (parity with ThreadList props)
  sessionStates?: Record<string, SessionState>
  sessionSources?: Record<string, string>
  sessionAgentNames?: Record<string, string>
  sessionTriggerLabels?: Record<string, string>

  // Pagination — sentinel sits at the very bottom of the scroll area.
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void

  // Session-level actions
  onSelectSession: (id: string) => void
  onRenameSession: (id: string, title: string) => Promise<void> | void
  onArchiveSession: (id: string) => Promise<void> | void
  onUnarchiveSession: (id: string) => Promise<void> | void
  onPinSession: (id: string, pinned: boolean) => Promise<void> | void
}

// ── Time bucketing ────────────────────────────────────────────────────────────

type TimeBucket = 'today' | 'yesterday' | 'last7' | 'last30' | 'earlier'

const BUCKET_ORDER: TimeBucket[] = ['today', 'yesterday', 'last7', 'last30', 'earlier']

const BUCKET_LABEL: Record<TimeBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  earlier: 'Earlier',
}

function bucketFor(activity: number, now: number): TimeBucket {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const today = startOfToday.getTime()
  const yesterday = today - 24 * 60 * 60 * 1000
  const sevenDaysAgo = today - 7 * 24 * 60 * 60 * 1000
  const thirtyDaysAgo = today - 30 * 24 * 60 * 60 * 1000

  if (activity >= today) return 'today'
  if (activity >= yesterday) return 'yesterday'
  if (activity >= sevenDaysAgo) return 'last7'
  if (activity >= thirtyDaysAgo) return 'last30'
  return 'earlier'
}

export const AgentSidebar: FC<AgentSidebarProps> = ({
  sessions,
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
}) => {
  // Bucket sessions: pinned (across all time), then by `lastActivity` time bucket.
  // A pinned session appears ONLY in the Pinned section to avoid duplicate rows.
  const { pinned, byBucket } = useMemo(() => {
    const now = Date.now()
    const pinned: SidebarSession[] = []
    const byBucket = new Map<TimeBucket, SidebarSession[]>()
    for (const s of sessions) {
      if (s.pinnedAt) {
        pinned.push(s)
        continue
      }
      const b = bucketFor(s.lastActivity, now)
      const list = byBucket.get(b) ?? []
      list.push(s)
      byBucket.set(b, list)
    }
    pinned.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0))
    return { pinned, byBucket }
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

  return (
    <div className="aui-root flex flex-1 min-h-0 flex-col gap-0.5 overflow-y-auto">
      {pinned.length > 0 && (
        <Section title="Pinned">
          {pinned.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
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
            />
          ))}
        </Section>
      )}

      {BUCKET_ORDER.map((b) => {
        const list = byBucket.get(b)
        if (!list || list.length === 0) return null
        return (
          <Section key={b} title={BUCKET_LABEL[b]}>
            {list.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
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
              />
            ))}
          </Section>
        )
      })}

      <div ref={sentinelRef} className="shrink-0 h-1" />
      {isLoadingMore && (
        <div className="flex items-center justify-center py-2">
          <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  )
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

const Section: FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex flex-col gap-0.5 mt-5 first:mt-0">
    <div className="px-2.5 pb-0.5 text-[11px] font-medium text-muted-foreground/70">
      {title}
    </div>
    {children}
  </div>
)

// ─── Session row ──────────────────────────────────────────────────────────────

interface SessionRowProps {
  session: SidebarSession
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
}

const SessionRow: FC<SessionRowProps> = ({
  session,
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
      className="group relative flex h-8 items-center gap-1 rounded-md transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none data-active:bg-muted"
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
