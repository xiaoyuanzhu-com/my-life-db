import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Pencil } from 'lucide-react'
import { cn } from '~/lib/utils'
import { api } from '~/lib/api'

export interface AutoAgentSummary {
  name: string
  agent: string
  trigger: string
  schedule?: string
  path?: string
  enabled: boolean
}

type SessionState = 'idle' | 'working' | 'unread' | 'archived'

interface SessionRow {
  id: string
  title: string
  summary?: string
  customTitle?: string
  agentName?: string
  lastUserActivity?: number
  lastActivity: number
}

interface Props {
  sessions: SessionRow[]
  activeSessionId: string | null
  editingAgentName: string | null
  sessionStates: Record<string, SessionState>
  sessionTriggerLabels: Record<string, string>
  onSelectAgent: (name: string) => void
  onSelectSession: (sessionId: string) => void
  /** Bumped by the parent to force a refetch after mutations. */
  refreshKey?: number
}

const UNKNOWN_GROUP = '__unknown__'

function sessionLabel(s: SessionRow, triggerLabel: string | undefined): string {
  return triggerLabel || s.customTitle || s.summary || s.title || s.id
}

function activityOf(s: SessionRow): number {
  return s.lastUserActivity ?? s.lastActivity
}

export function AutoAgentTree({
  sessions,
  activeSessionId,
  editingAgentName,
  sessionStates,
  sessionTriggerLabels,
  onSelectAgent,
  onSelectSession,
  refreshKey = 0,
}: Props) {
  const [defs, setDefs] = useState<AutoAgentSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    api
      .get('/api/agent/defs')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (!cancelled) {
          setDefs(data.defs ?? [])
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  // Group sessions by agentName. Build one group per known def, plus a synthetic
  // group for orphaned sessions (agentName references a deleted def).
  const groups = useMemo(() => {
    const byAgent = new Map<string, SessionRow[]>()
    const knownNames = new Set(defs.map((d) => d.name))
    for (const s of sessions) {
      const key = s.agentName && knownNames.has(s.agentName) ? s.agentName : UNKNOWN_GROUP
      const list = byAgent.get(key) ?? []
      list.push(s)
      byAgent.set(key, list)
    }
    // Sort sessions within each group, latest first.
    for (const list of byAgent.values()) {
      list.sort((a, b) => activityOf(b) - activityOf(a))
    }

    type Group = {
      key: string
      def?: AutoAgentSummary
      sessions: SessionRow[]
      latestActivity: number
    }
    const result: Group[] = defs.map((def) => {
      const list = byAgent.get(def.name) ?? []
      return {
        key: def.name,
        def,
        sessions: list,
        latestActivity: list.length > 0 ? activityOf(list[0]) : 0,
      }
    })

    // Orphaned sessions whose agent def was deleted.
    const orphans = byAgent.get(UNKNOWN_GROUP) ?? []
    if (orphans.length > 0) {
      result.push({
        key: UNKNOWN_GROUP,
        sessions: orphans,
        latestActivity: activityOf(orphans[0]),
      })
    }

    // Sort: groups with sessions by latest activity desc; groups without
    // sessions to the bottom, alphabetically among themselves. Orphan group
    // (no def) is treated as "has sessions" and sorts by activity.
    result.sort((a, b) => {
      const aHas = a.sessions.length > 0
      const bHas = b.sessions.length > 0
      if (aHas !== bHas) return aHas ? -1 : 1
      if (aHas) return b.latestActivity - a.latestActivity
      return (a.def?.name ?? a.key).localeCompare(b.def?.name ?? b.key)
    })

    return result
  }, [defs, sessions])

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  if (error) {
    return <div className="p-4 text-sm text-destructive">{error}</div>
  }

  if (groups.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No auto agents yet. Click + to create one.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5 overflow-y-auto py-1">
      {groups.map((group) => {
        const isCollapsed = !!collapsed[group.key]
        const isOrphan = !group.def
        const displayName = group.def?.name ?? '(unknown agent)'
        const isEditing = editingAgentName != null && editingAgentName === group.def?.name
        return (
          <div key={group.key} className="flex flex-col">
            {/* Agent header */}
            <div
              className={cn(
                'group flex h-8 items-center gap-1 rounded-md transition-colors hover:bg-muted',
                isEditing && 'bg-muted'
              )}
            >
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                className="flex h-full min-w-0 flex-1 items-center px-2.5 text-start text-[13px]"
              >
                {isCollapsed ? (
                  <ChevronRight className="mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate font-medium',
                    isOrphan ? 'text-muted-foreground italic' : 'text-foreground'
                  )}
                  title={displayName}
                >
                  {displayName}
                </span>
                {group.def && !group.def.enabled && (
                  <span className="ml-1.5 shrink-0 rounded bg-muted-foreground/15 px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                    off
                  </span>
                )}
              </button>
              {group.def && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelectAgent(group.def!.name)
                  }}
                  className={cn(
                    'mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground',
                    // Always visible on mobile (no hover); hover-revealed on
                    // desktop. Pinned visible when this agent is being edited.
                    'md:opacity-0 md:group-hover:opacity-100',
                    isEditing && 'md:opacity-100'
                  )}
                  title="Edit agent"
                >
                  <Pencil className="size-3.5" />
                </button>
              )}
            </div>

            {/* Sessions (level 2) */}
            {!isCollapsed && (
              <div className="flex flex-col gap-0.5 pl-5">
                {group.sessions.length === 0 ? (
                  <div className="flex h-7 items-center px-2.5 text-[12px] text-muted-foreground/70">
                    No sessions yet
                  </div>
                ) : (
                  group.sessions.map((s) => {
                    const isActive = s.id === activeSessionId
                    const state = sessionStates[s.id]
                    const isArchived = state === 'archived'
                    const showDot =
                      !isActive && (state === 'working' || state === 'unread')
                    const label = sessionLabel(s, sessionTriggerLabels[s.id])
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => onSelectSession(s.id)}
                        className={cn(
                          'flex h-7 items-center gap-1 rounded-md px-2.5 text-start text-[13px] transition-colors hover:bg-muted',
                          isActive && 'bg-muted'
                        )}
                      >
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate',
                            isActive
                              ? 'text-foreground'
                              : isArchived
                                ? 'text-foreground/40'
                                : 'text-foreground/80'
                          )}
                          title={label}
                        >
                          {label}
                        </span>
                        <span className="ml-1 flex w-2 shrink-0 items-center">
                          {showDot && (
                            <span
                              className={cn(
                                'h-2 w-2 shrink-0 rounded-full',
                                state === 'working'
                                  ? 'bg-amber-500'
                                  : 'bg-emerald-500'
                              )}
                              title={
                                state === 'working'
                                  ? 'Agent is working'
                                  : 'New messages — waiting for you'
                              }
                            />
                          )}
                        </span>
                      </button>
                    )
                  })
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
