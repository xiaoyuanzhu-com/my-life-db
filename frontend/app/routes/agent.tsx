import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate, useParams, useLocation, useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { AgentSidebar } from '~/components/agent/agent-sidebar'
import { setAgentSessionPinned } from '~/lib/agent-groups'
import { type AgentType } from '~/components/agent/agent-type-selector'
import type { ConfigOption } from '~/hooks/use-agent-runtime'
import { AgentChat } from '~/components/agent/agent-chat'
import { AgentContextProvider } from '~/components/agent/agent-context'
import { AutoAgentTree } from '~/components/agent/auto-agent-tree'
import { AutoAgentEditor } from '~/components/agent/auto-agent-editor'
import { useAgentRuntime } from '~/hooks/use-agent-runtime'
import { Button } from '~/components/ui/button'
import { Plus, PanelLeftClose, PanelLeftOpen, ChevronDown, ArrowLeft, Share2, Link, Check, Globe, Loader2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '~/components/ui/resizable'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '~/components/ui/dialog'
import { Switch } from '~/components/ui/switch'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import { cn } from '~/lib/utils'
import { useAuth } from '~/contexts/auth-context'
import { useFeatureFlags } from '~/contexts/feature-flags-context'
import { useAgentSessionNotifications } from '~/hooks/use-notifications'
import { useIsMobile } from '~/hooks/use-is-mobile'
import { api } from '~/lib/api'
import { isNativeApp } from '~/lib/native-bridge'
import { fetchWithRefresh } from '~/lib/fetch-with-refresh'
import '@fontsource/jetbrains-mono'

interface Session {
  id: string
  title: string // firstPrompt - fallback title
  summary?: string // AI-generated 5-10 word title
  customTitle?: string // User-set custom title (via /title command)
  workingDir: string
  sessionState: 'idle' | 'working' | 'unread' | 'archived'
  createdAt: number
  lastActivity: number
  lastUserActivity?: number
  messageCount?: number
  gitBranch?: string
  permissionMode?: string // From active session runtime state (empty for historical)
  agentType?: string
  shareToken?: string
  shareUrl?: string
  source?: 'user' | 'auto'
  agentName?: string
  triggerKind?: string
  triggerData?: Record<string, unknown>
  storageId?: string // Per-session storage folder id; used to scope subsequent uploads
  groupId?: string | null // Sidebar group assignment (null/undefined = ungrouped)
  pinnedAt?: number | null // Epoch ms when pinned, null/undefined = not pinned
}

// Build a short, per-run label describing what fired an auto session.
// Examples: "cron 10:30", "new file inbox/foo.md", "changed notes/bar.md".
// Returns undefined for user sessions or auto sessions from before the
// trigger context columns were added (migration 022).
function formatTriggerLabel(
  kind: string | undefined,
  data: Record<string, unknown> | undefined,
  createdAt: number
): string | undefined {
  if (!kind) return undefined
  const path = typeof data?.path === 'string' ? (data.path as string) : undefined
  switch (kind) {
    case 'cron.tick': {
      // Use the fire timestamp (createdAt) so consecutive cron runs are
      // distinguishable. Include month + day since daily/weekly jobs need
      // the date to disambiguate; time alone would collapse identical
      // hours across different days.
      const d = new Date(createdAt)
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const mon = months[d.getMonth()]
      const day = d.getDate()
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      return `cron ${mon} ${day} ${hh}:${mm}`
    }
    case 'file.created':
      return path ? `new ${path}` : 'new file'
    case 'file.changed':
      return path ? `changed ${path}` : 'changed file'
    case 'file.moved':
      return path ? `moved ${path}` : 'moved file'
    case 'file.deleted':
      return path ? `deleted ${path}` : 'deleted file'
    case 'app.started':
      return 'app started'
    case 'app.stopping':
      return 'app stopping'
    default:
      return kind
  }
}

interface Pagination {
  hasMore: boolean
  nextCursor: string | null
  totalCount: number
}

type StatusFilter = 'all' | 'active' | 'archived'
type SidebarView = 'sessions' | 'agents'

function ShareButton({ session, onUpdate }: { session: Session; onUpdate: (s: Partial<Session>) => void }) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [copied, setCopied] = useState(false)

  const isShared = !!session.shareToken

  const fullShareUrl = session.shareUrl
    ? `${window.location.origin}${session.shareUrl}`
    : ''

  const handleToggleShare = async (checked: boolean) => {
    setSharing(true)
    try {
      if (checked) {
        const res = await fetchWithRefresh(`/api/agent/sessions/${session.id}/share`, {
          method: 'POST',
        })
        if (!res.ok) throw new Error(`Failed to share: ${res.status}`)
        const data = await res.json()
        onUpdate({ shareToken: data.shareToken, shareUrl: data.shareUrl })
      } else {
        const res = await fetchWithRefresh(`/api/agent/sessions/${session.id}/share`, {
          method: 'DELETE',
        })
        if (!res.ok) throw new Error(`Failed to unshare: ${res.status}`)
        onUpdate({ shareToken: undefined, shareUrl: undefined })
      }
    } catch (err) {
      console.error('Failed to update share state:', err)
    } finally {
      setSharing(false)
    }
  }

  const handleCopy = () => {
    if (!fullShareUrl) return
    navigator.clipboard.writeText(fullShareUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => setOpen(true)}
        title="Share session"
      >
        <Share2 className={cn('h-4 w-4', isShared && 'text-primary')} />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('share.dialogTitle', 'Share session')}</DialogTitle>
            <DialogDescription>
              {t('share.dialogDescription', 'Anyone with the link can view this session (read-only).')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Share toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{t('share.publicLink', 'Public link')}</span>
              </div>
              <div className="flex items-center gap-2">
                {sharing && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                <Switch
                  checked={isShared}
                  onCheckedChange={handleToggleShare}
                  disabled={sharing}
                />
              </div>
            </div>

            {/* Share URL (only when shared) */}
            {isShared && (
              <div className="flex items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2">
                  <Link className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm text-foreground">{fullShareUrl}</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0 gap-1.5 px-3"
                  onClick={handleCopy}
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4" />
                      {t('share.copied', 'Copied')}
                    </>
                  ) : (
                    t('share.copyLink', 'Copy link')
                  )}
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default function AgentPage() {
  const { t } = useTranslation('agent')
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const { sessionSidebar, sessionCreateNew } = useFeatureFlags()
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const location = useLocation()
  const { sessionId: urlSessionId } = useParams()
  // URL is the source of truth for both sidebarView and activeSessionId.
  // `/agent/auto` and `/agent/auto/:sessionId` → 'agents'; otherwise → 'sessions'.
  const isAutoRoute =
    location.pathname === '/agent/auto' || location.pathname.startsWith('/agent/auto/')
  const sidebarView: SidebarView = isAutoRoute ? 'agents' : 'sessions'
  const activeSessionId = urlSessionId ?? null
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const touchStartX = useRef<number>(0)
  const touchEndX = useRef<number>(0)
  // Track previous activeSessionId so handlers can choose push vs replace
  // (push when entering from list, replace when switching between sessions).
  const prevActiveSessionIdRef = useRef<string | null>(activeSessionId)
  // Track the latest storageId minted by the draft attachment hook so we can
  // include it in the session-create POST without prop-drilling state.
  const draftStorageIdRef = useRef<string | null>(null)
  const handleAttachmentsStorageIdChange = useCallback((storageId: string | null) => {
    draftStorageIdRef.current = storageId
  }, [])
  useEffect(() => {
    prevActiveSessionIdRef.current = activeSessionId
  }, [activeSessionId])

  // Navigate to the URL for a session, preserving native-app replace semantics
  // and correct push vs replace for browser history.
  const goToSession = useCallback(
    (sessionId: string, source?: 'auto' | 'user') => {
      const useReplace = isNativeApp() || prevActiveSessionIdRef.current != null
      const base = source === 'auto' ? '/agent/auto' : '/agent'
      navigate(`${base}/${sessionId}`, { replace: useReplace })
    },
    [navigate]
  )

  // Navigate to the list URL for the current tab.
  const goToList = useCallback(() => {
    navigate(isAutoRoute ? '/agent/auto' : '/agent')
  }, [isAutoRoute, navigate])

  // Pagination state
  const [pagination, setPagination] = useState<Pagination>({
    hasMore: false,
    nextCursor: null,
    totalCount: 0,
  })
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('agent-session-filter')
      if (saved === 'all' || saved === 'active' || saved === 'archived') {
        return saved
      }
    }
    return 'active'
  })
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  // Sidebar collapse state (desktop)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('agent-sidebar-collapsed') === 'true'
    }
    return false
  })

  // Auto-agent editor — renders in the session-detail container when an
  // agent is selected from the sidebar tree. null = not editing any agent.
  const [editingAgentName, setEditingAgentName] = useState<string | null>(null)
  // Bumped after save/delete to force the tree to refetch defs.
  const [agentsPanelRefresh, setAgentsPanelRefresh] = useState(0)

  const openAgentEditor = useCallback((name: string) => {
    // Clear any active session URL so the main panel shows the editor, not a session.
    goToList()
    setEditingAgentName(name)
  }, [goToList])
  const closeAgentEditor = useCallback(() => {
    setEditingAgentName(null)
  }, [])
  const handleAgentSaved = useCallback(() => {
    setAgentsPanelRefresh((n) => n + 1)
  }, [])
  const handleAgentDeleted = useCallback(() => {
    setAgentsPanelRefresh((n) => n + 1)
    setEditingAgentName(null)
  }, [])

  // Bumped when we seed the new-session composer via localStorage — forces
  // AgentChat (empty state) to remount so useDraftPersistence re-reads the seed.
  const [newSessionComposerKey, setNewSessionComposerKey] = useState(0)

  // Seed the new-session composer with a prompt, then navigate to the
  // Sessions view's empty/new state. The composer picks up the seed via the
  // `agent-input:new-session` localStorage key on mount.
  const seedNewSession = useCallback((prompt: string) => {
    localStorage.setItem('agent-input:new-session', prompt)
    navigate('/agent')
    setShowNewSessionMobile(true)
    setNewSessionComposerKey((k) => k + 1)
    setEditingAgentName(null)
  }, [navigate])

  const handleCreateAgentWithAI = useCallback(() => {
    seedNewSession(`/create-auto-agent`)
  }, [seedNewSession])

  const handleEditAgentWithAI = useCallback((name: string, markdown: string) => {
    seedNewSession(
      `/create-auto-agent\n\n` +
      `Help me edit my existing auto agent at \`agents/${name}/${name}.md\`.\n\n` +
      `Current definition:\n\n\`\`\`markdown\n${markdown}\n\`\`\``
    )
  }, [seedNewSession])

  // Honor ?seed=<prompt> URL param: prefill the new-session composer whenever
  // the param appears, then strip it so a refresh doesn't re-seed. Reacting to
  // searchParams (not just mount) lets in-app links from /agent/:id trigger
  // seeding without a full route remount.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const seed = searchParams.get('seed')
    if (!seed) return
    seedNewSession(seed)
    const next = new URLSearchParams(searchParams)
    next.delete('seed')
    setSearchParams(next, { replace: true })
  }, [searchParams, seedNewSession, setSearchParams])

  // Honor ?edit=<name> URL param on /agent/auto: open the editor for that
  // agent and strip the param so the URL reflects steady state. Used by the
  // native iOS shell to deep-link into a specific auto-agent editor.
  useEffect(() => {
    if (!isAutoRoute) return
    const editName = searchParams.get('edit')
    if (!editName) return
    openAgentEditor(editName)
    const next = new URLSearchParams(searchParams)
    next.delete('edit')
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAutoRoute, searchParams])

  const sidebarPanelRef = useRef<ImperativePanelHandle>(null)

  // New session state (for empty state)
  // Initialize from localStorage if available
  const [newSessionWorkingDir, setNewSessionWorkingDir] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('agent-last-working-dir') || ''
    }
    return ''
  })
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  // Mobile: distinguish "viewing session list" from "composing new session"
  const [showNewSessionMobile, setShowNewSessionMobile] = useState(false)
  // Permission mode for new session (empty state)
  // - Stored locally until session is created
  // - Changing this does NOT create a session or send any request
  // - Passed to createSessionWithMessage API when user sends first message
  // Agent type for new session
  const [newSessionAgentType, setNewSessionAgentType] = useState<AgentType>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('mld-agent-type')
      if (saved === 'claude_code' || saved === 'codex') {
        return saved
      }
    }
    return 'claude_code'
  })

  // Per-agent-type user-preferred defaults for new sessions (configId → value)
  const [newSessionDefaults, setNewSessionDefaults] = useState<Record<string, Record<string, string>>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('agent-session-defaults')
      if (saved) {
        try { return JSON.parse(saved) } catch { /* ignore */ }
      }
    }
    return { claude_code: { mode: 'bypassPermissions' }, codex: { mode: 'full-access' } }
  })

  // Per-agent-type default config options from the backend.
  // Backend returns defaults for each agent type, with AGENT_MODELS overriding
  // the model options when configured.
  const [defaultConfigOptions, setDefaultConfigOptions] = useState<Record<string, ConfigOption[]>>({})
  useEffect(() => {
    fetch('/api/agent/config')
      .then(res => res.json())
      .then(data => {
        if (data.defaultConfigOptions) {
          setDefaultConfigOptions(data.defaultConfigOptions)
          // Reconcile persisted newSessionDefaults against the fresh option list —
          // values stored in localStorage from a previous AGENT_MODELS config may
          // no longer exist (e.g. model renamed/removed), and sending one to the
          // backend would otherwise fail with an invalid-model error.
          setNewSessionDefaults(prev => {
            let changed = false
            const next: Record<string, Record<string, string>> = {}
            for (const [agentType, saved] of Object.entries(prev)) {
              const opts = data.defaultConfigOptions[agentType] ?? []
              const cleaned: Record<string, string> = {}
              for (const [configId, value] of Object.entries(saved)) {
                const opt = opts.find((o: ConfigOption) => o.id === configId)
                if (!opt || opt.options.some((c: { value: string }) => c.value === value)) {
                  cleaned[configId] = value
                } else {
                  changed = true
                }
              }
              next[agentType] = cleaned
            }
            return changed ? next : prev
          })
        }
      })
      .catch(() => {}) // silently ignore — self-hosted may not have agent configured
  }, [])

  // Result count — increments on each agent session update, used as refreshKey for changed files popover
  const [resultCount, setResultCount] = useState(0)

  // Get active session - use ref to cache and prevent unmount during session list refresh
  // This prevents ChatInterface from unmounting when sessions array temporarily
  // doesn't contain the active session (e.g., during filter changes or refresh)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const cachedActiveSessionRef = useRef<Session | undefined>(undefined)

  // Update cache when we have a valid session, but don't clear it when undefined
  // This keeps ChatInterface mounted during brief periods where activeSession is undefined
  if (activeSession) {
    cachedActiveSessionRef.current = activeSession
  }

  // Use cached session if current lookup failed but we have a cached value
  // Clear cache only when activeSessionId changes (user explicitly switched sessions)
  const effectiveActiveSession = activeSession ||
    (cachedActiveSessionRef.current?.id === activeSessionId ? cachedActiveSessionRef.current : undefined)

  // Persist working directory to localStorage
  useEffect(() => {
    if (newSessionWorkingDir) {
      localStorage.setItem('agent-last-working-dir', newSessionWorkingDir)
    }
  }, [newSessionWorkingDir])

  // Persist session filter to localStorage
  useEffect(() => {
    localStorage.setItem('agent-session-filter', statusFilter)
  }, [statusFilter])

  // Persist agent type to localStorage
  useEffect(() => {
    localStorage.setItem('mld-agent-type', newSessionAgentType)
  }, [newSessionAgentType])

  // Persist session defaults to localStorage
  useEffect(() => {
    localStorage.setItem('agent-session-defaults', JSON.stringify(newSessionDefaults))
  }, [newSessionDefaults])

  // Persist sidebar collapsed state
  useEffect(() => {
    localStorage.setItem('agent-sidebar-collapsed', String(isSidebarCollapsed))
  }, [isSidebarCollapsed])

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

  // Reset resultCount when session changes
  useEffect(() => {
    setResultCount(0)
  }, [activeSessionId])

  // Sort sessions by last USER activity (most recent first)
  // Uses lastUserActivity (only updated on user input) instead of lastActivity
  // (updated on any file write) to prevent sessions from jumping when the agent responds
  const sortSessions = (sessionList: Session[]): Session[] => {
    return [...sessionList].sort((a: Session, b: Session) => {
      const dateA = a.lastUserActivity || a.lastActivity
      const dateB = b.lastUserActivity || b.lastActivity
      return dateB - dateA
    })
  }

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true)
      // Fetch first page of sessions with pagination
      const params = new URLSearchParams({
        limit: '50',
        status: statusFilter,
      })

      const response = await api.get(`/api/agent/sessions/all?${params}`)
      const data = await response.json()
      const sessionList = data.sessions || []

      setSessions(sortSessions(sessionList))
      setPagination({
        hasMore: data.pagination?.hasMore ?? false,
        nextCursor: data.pagination?.nextCursor ?? null,
        totalCount: data.pagination?.totalCount ?? sessionList.length,
      })
    } catch (error) {
      console.error('Failed to load sessions:', error)
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  // Background refresh - updates sessions without showing loading state.
  // Used for SSE-triggered updates (e.g., title changes, new sessions, state changes).
  //
  // Design: the API response is authoritative. This is a full replacement of the
  // first page, not an accumulator merge. Sessions loaded via scroll-up pagination
  // (older than the API window) are preserved; everything else is replaced.
  // This ensures all tabs converge to the same state after each SSE event.
  const refreshSessions = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        limit: '50',
        status: statusFilter,
      })

      const response = await api.get(`/api/agent/sessions/all?${params}`)
      const data = await response.json()
      const newSessionList: Session[] = data.sessions || []

      // Diagnostic: log non-idle session states to debug working→idle skip
      const nonIdle = newSessionList.filter(s => s.sessionState !== 'idle')
      if (nonIdle.length > 0) {
        console.log('[agent] refreshSessions states:', nonIdle.map(s => `${s.id.slice(0, 8)}=${s.sessionState}`).join(', '))
      }

      setSessions((prevSessions) => {
        const newMap = new Map(newSessionList.map((s) => [s.id, s]))

        // Diagnostic: log per-session state transitions (prev→new).
        // Critical for diagnosing working→idle skip — distinguishes whether
        // backend returned the wrong state vs frontend dropped an unread state.
        const transitions: string[] = []
        for (const s of newSessionList) {
          const prev = prevSessions.find(p => p.id === s.id)
          if (prev && prev.sessionState !== s.sessionState) {
            transitions.push(`${s.id.slice(0, 8)}:${prev.sessionState}→${s.sessionState}`)
          }
        }
        if (transitions.length > 0) {
          console.log('[agent] refreshSessions transitions:', transitions.join(', '), '| activeSessionId:', activeSessionIdRef.current?.slice(0, 8) ?? 'none')
        }

        // API response is the source of truth for the first page.
        const result = [...newSessionList]

        // Preserve sessions loaded via scroll-up pagination — these are older
        // than the API's first page and would be lost on a simple replacement.
        // Heuristic: if a previous session is NOT in the API response and its
        // activity is older than the oldest session in the response, it was
        // loaded via pagination. Anything newer but missing is stale (phantom
        // warm sessions, optimistic adds the API hasn't caught up to yet).
        if (newSessionList.length > 0) {
          const oldestInResponse = Math.min(
            ...newSessionList.map(s => s.lastUserActivity || s.lastActivity)
          )
          for (const s of prevSessions) {
            if (!newMap.has(s.id)) {
              const activity = s.lastUserActivity || s.lastActivity
              if (activity < oldestInResponse) {
                result.push(s)
              }
            }
          }
        }

        return sortSessions(result)
      })

      setPagination({
        hasMore: data.pagination?.hasMore ?? false,
        nextCursor: data.pagination?.nextCursor ?? null,
        totalCount: data.pagination?.totalCount ?? newSessionList.length,
      })
    } catch (error) {
      console.error('Failed to refresh sessions:', error)
    }
  }, [statusFilter])

  // Load sessions on mount or when filter changes
  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  // Fetch individual session when activeSessionId is set but not in the loaded sessions
  // (e.g., navigating directly to an archived session URL while filter is "active").
  // Uses a ref to read sessions without depending on it — avoids re-triggering on every
  // session list update (clicking around, SSE refreshes, etc.).
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  // Kept in sync for diagnostic logging in refreshSessions (whose useCallback
  // intentionally excludes activeSessionId from deps to avoid cascade re-runs).
  const activeSessionIdRef = useRef(activeSessionId)
  activeSessionIdRef.current = activeSessionId

  useEffect(() => {
    if (!activeSessionId || loading) return
    if (sessionsRef.current.some((s) => s.id === activeSessionId)) return

    let cancelled = false
    api.get(`/api/agent/sessions/${activeSessionId}`).then(async (res) => {
      if (cancelled) return
      if (!res.ok) return
      const data = await res.json()
      const session: Session = {
        id: data.id,
        title: data.title || data.id,
        workingDir: data.workingDir || '',
        sessionState: data.sessionState || 'idle',
        createdAt: data.createdAt || 0,
        lastActivity: data.lastActivity || 0,
        lastUserActivity: data.lastUserActivity,
        messageCount: data.messageCount,
        permissionMode: data.permissionMode,
        source: data.source,
        agentName: data.agentName,
        triggerKind: data.triggerKind,
        triggerData: data.triggerData,
        storageId: data.storageId,
      }
      setSessions((prev) => {
        if (prev.some((s) => s.id === session.id)) return prev
        return [...prev, session]
      })
    }).catch(() => {})

    return () => { cancelled = true }
  }, [activeSessionId, loading])

  // Push a history entry when entering mobile new-session view so that
  // the browser's native swipe-back returns to the session list.
  // Skip in native app — SwiftUI NavigationStack owns back navigation.
  useEffect(() => {
    if (!showNewSessionMobile) return
    if (isNativeApp()) return
    const isMobile = window.innerWidth < 768
    if (!isMobile) return

    window.history.pushState({ mobileNewSession: true }, '')

    const handlePopState = () => {
      setShowNewSessionMobile(false)
    }

    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
    }
  }, [showNewSessionMobile])

  // Swipe gesture handler for mobile back navigation
  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      // Yield to fullscreen preview — let the iframe handle all gestures
      if (document.body.hasAttribute('data-fullscreen-preview')) return

      // Only start tracking if touch starts from left edge (within 50px)
      if (e.touches[0].clientX < 50) {
        touchStartX.current = e.touches[0].clientX
        touchEndX.current = e.touches[0].clientX
      } else {
        // Reset to indicate we're not tracking this gesture
        touchStartX.current = 0
        touchEndX.current = 0
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      // Only track if we started from the edge
      if (touchStartX.current > 0) {
        touchEndX.current = e.touches[0].clientX
      }
    }

    const handleTouchEnd = () => {
      // Only navigate if:
      // 1. We started from the left edge (touchStartX > 0)
      // 2. Swipe was rightward (end X > start X)
      // 3. Swipe distance was significant (> 100px)
      if (touchStartX.current > 0 && touchEndX.current - touchStartX.current > 100) {
        if (activeSessionId) {
          goToList()
        } else if (showNewSessionMobile) {
          // Pop the history entry we pushed for the new-session view
          window.history.back()
        }
      }

      // Reset for next gesture
      touchStartX.current = 0
      touchEndX.current = 0
    }

    // Active on mobile when viewing session detail OR new-session compose view.
    // Skip in native app — the native interactive pop gesture handles this.
    const isMobile = window.innerWidth < 768
    if (isMobile && !isNativeApp() && (activeSessionId || showNewSessionMobile)) {
      document.addEventListener('touchstart', handleTouchStart, { passive: true })
      document.addEventListener('touchmove', handleTouchMove, { passive: true })
      document.addEventListener('touchend', handleTouchEnd)
    }

    return () => {
      document.removeEventListener('touchstart', handleTouchStart)
      document.removeEventListener('touchmove', handleTouchMove)
      document.removeEventListener('touchend', handleTouchEnd)
    }
  }, [activeSessionId, showNewSessionMobile, goToList])

  // Refresh session list when titles change (SSE from backend)
  // Uses refreshSessions for seamless background updates without loading flash
  const handleSessionUpdated = useCallback(() => {
    refreshSessions()
    setResultCount((prev) => prev + 1)
  }, [refreshSessions])

  useAgentSessionNotifications({
    onSessionUpdated: handleSessionUpdated,
    enabled: isAuthenticated,
  })

  // Load more sessions (infinite scroll)
  const loadMoreSessions = useCallback(async () => {
    if (!pagination.hasMore || isLoadingMore || !pagination.nextCursor) return

    try {
      setIsLoadingMore(true)
      const params = new URLSearchParams({
        limit: '50',
        status: statusFilter,
        cursor: pagination.nextCursor,
      })

      const response = await api.get(`/api/agent/sessions/all?${params}`)
      const data = await response.json()
      const newSessions = data.sessions || []

      // Append new sessions, avoiding duplicates
      setSessions((prev) => {
        const existingIds = new Set(prev.map((s) => s.id))
        const uniqueNewSessions = newSessions.filter((s: Session) => !existingIds.has(s.id))
        return sortSessions([...prev, ...uniqueNewSessions])
      })

      setPagination({
        hasMore: data.pagination?.hasMore ?? false,
        nextCursor: data.pagination?.nextCursor ?? null,
        totalCount: data.pagination?.totalCount ?? pagination.totalCount,
      })
    } catch (error) {
      console.error('Failed to load more sessions:', error)
    } finally {
      setIsLoadingMore(false)
    }
  }, [pagination.hasMore, pagination.nextCursor, pagination.totalCount, isLoadingMore, statusFilter])

  // Create a new session and send the first message.
  // Session + CLI process are spun up on demand — no eager/warm session.
  const createSessionWithMessage = async (message: string) => {
    if (!message || isCreatingSession) return

    setIsCreatingSession(true)
    try {
      // Mirror newSessionConfigOptions: user pref wins, otherwise fall back to
      // the backend-supplied default. The dropdown displays the merged value,
      // so the request must send the same value — otherwise the UI shows
      // (e.g.) "Full Access" while the backend logs permissionMode= empty.
      const opts = defaultConfigOptions[newSessionAgentType] ?? []
      const prefs = newSessionDefaults[newSessionAgentType] ?? {}
      const effectiveValue = (id: string) =>
        prefs[id] || opts.find(o => o.id === id)?.currentValue
      const effectiveMode = effectiveValue('mode')
      const effectiveModel = effectiveValue('model')

      const response = await api.post('/api/agent/sessions', {
        title: message,
        message: message,
        workingDir: newSessionWorkingDir,
        permissionMode: effectiveMode || undefined,
        agentType: newSessionAgentType,
        model: effectiveModel || undefined,
        storageId: draftStorageIdRef.current ?? undefined,
      })

      if (!response.ok) {
        throw new Error(`Failed to create session: ${response.status}`)
      }

      const session = await response.json()
      const newSession: Session = {
        id: session.id,
        title: message,
        workingDir: newSessionWorkingDir,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        lastUserActivity: Date.now(),
        sessionState: 'idle',
        permissionMode: effectiveMode || 'default',
        agentType: session.agentType ?? newSessionAgentType,
        storageId: session.storageId,
      }

      setSessions((prevSessions) => {
        const without = prevSessions.filter((s) => s.id !== newSession.id)
        return sortSessions([newSession, ...without])
      })
      // New sessions created via the composer are user sessions → /agent/:id.
      goToSession(session.id, 'user')
      setShowNewSessionMobile(false)
      localStorage.removeItem('agent-input:new-session')
    } catch (error) {
      console.error('Failed to create session:', error)
      throw error // Re-throw so the runtime can restore composer text
    } finally {
      setIsCreatingSession(false)
    }
  }


  const updateSessionTitle = async (sessionId: string, title: string) => {
    try {
      await api.patch(`/api/agent/sessions/${sessionId}`, { title })

      setSessions(
        sessions.map((s) => (s.id === sessionId ? { ...s, title } : s))
      )
    } catch (error) {
      console.error('Failed to update session:', error)
    }
  }

  const archiveSession = async (sessionId: string) => {
    try {
      const response = await api.post(`/api/agent/sessions/${sessionId}/archive`)

      if (response.ok) {
        if (statusFilter === 'active') {
          // Remove from list when viewing active sessions
          setSessions(sessions.filter((s) => s.id !== sessionId))
        } else {
          setSessions(
            sessions.map((s) =>
              s.id === sessionId ? { ...s, sessionState: 'archived' as const } : s
            )
          )
        }
      }
    } catch (error) {
      console.error('Failed to archive session:', error)
    }
  }

  const handlePinSession = useCallback(async (sessionId: string, pinned: boolean) => {
    const now = Date.now()
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, pinnedAt: pinned ? now : null } : s)),
    )
    try {
      await setAgentSessionPinned(sessionId, pinned)
    } catch (err) {
      console.error('Failed to pin/unpin session:', err)
    }
  }, [])

  const unarchiveSession = async (sessionId: string) => {
    try {
      const response = await api.post(`/api/agent/sessions/${sessionId}/unarchive`)

      if (response.ok) {
        if (statusFilter === 'archived') {
          // Remove from list when viewing archived sessions
          setSessions(sessions.filter((s) => s.id !== sessionId))
        } else {
          setSessions(
            sessions.map((s) =>
              s.id === sessionId ? { ...s, sessionState: 'idle' as const } : s
            )
          )
        }
      }
    } catch (error) {
      console.error('Failed to unarchive session:', error)
    }
  }

  // Select a session — read state is tracked automatically by the subscribe
  // WebSocket (mark-as-read on connect + disconnect), so no API call needed here.
  // Optimistically clear the unread dot so it disappears immediately; the next
  // SSE-triggered refresh will confirm the server state.
  const handleSelectSession = useCallback((sessionId: string) => {
    // Only clear "unread" optimistically — not "working".
    // Clicking a working session should keep the amber dot visible.
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId && s.sessionState === 'unread'
          ? { ...s, sessionState: 'idle' as const }
          : s
      )
    )
    const session = sessionsRef.current.find((s) => s.id === sessionId)
    goToSession(sessionId, session?.source === 'auto' ? 'auto' : 'user')
    setShowNewSessionMobile(false)
    setEditingAgentName(null)
  }, [goToSession])

  // Update share fields on a session (called by ShareButton)
  const updateSessionShare = useCallback((sessionId: string, fields: Partial<Session>) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, ...fields } : s))
    )
  }, [])

  // Sessions filtered by source for the active sidebar tab.
  // Sessions tab → user-initiated; Auto tab → auto-agent-initiated.
  const visibleSessions = useMemo(() => {
    if (sidebarView === 'agents') return sessions.filter((s) => s.source === 'auto')
    return sessions.filter((s) => s.source !== 'auto')
  }, [sessions, sidebarView])

  // Build a map of session ID → sessionState for the thread list status dots
  const sessionStates = useMemo(() => {
    const map: Record<string, 'idle' | 'working' | 'unread' | 'archived'> = {}
    for (const s of sessions) {
      map[s.id] = s.sessionState
    }
    return map
  }, [sessions])

  // Build a map of session ID → source for the thread list "auto" badge
  const sessionSources = useMemo(() => {
    const map: Record<string, string> = {}
    for (const s of sessions) {
      if (s.source) map[s.id] = s.source
    }
    return map
  }, [sessions])

  // Build a map of session ID → agentName for the thread list label on auto sessions
  const sessionAgentNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const s of sessions) {
      if (s.agentName) map[s.id] = s.agentName
    }
    return map
  }, [sessions])

  // Build a map of session ID → triggerLabel for the thread list row's
  // main label on auto sessions (replaces the static title).
  const sessionTriggerLabels = useMemo(() => {
    const map: Record<string, string> = {}
    for (const s of sessions) {
      const label = formatTriggerLabel(s.triggerKind, s.triggerData, s.createdAt)
      if (label) map[s.id] = label
    }
    return map
  }, [sessions])

  // ── Agent Runtime (lifted from AgentChat) ─────────────────────────────────
  // The runtime is owned at the route level so that AssistantRuntimeProvider
  // wraps all AgentChat instances. The key on the provider forces a remount
  // on session switch, preserving the original reset behavior.
  const hasActiveSession = Boolean(activeSessionId)
  const activeSessionAgentType =
    effectiveActiveSession?.agentType === 'codex' || effectiveActiveSession?.agentType === 'claude_code'
      ? effectiveActiveSession.agentType
      : undefined
  const onSendForRuntime = !hasActiveSession ? createSessionWithMessage : undefined
  const { runtime, connected, sessionMeta, pendingPermissions, planEntries, sendPermissionResponse, sendSetConfigOption, historyLoadError, sessionError, subagentChildrenMap, pendingComposerText, clearPendingComposerText } =
    useAgentRuntime({
      sessionId: activeSessionId || "",
      token: "",
      enabled: hasActiveSession,
      onSend: onSendForRuntime,
      sessions: visibleSessions,
      activeSessionId,
      onSwitchToThread: handleSelectSession,
      onSwitchToNewThread: goToList,
      onRenameThread: updateSessionTitle,
      onArchiveThread: archiveSession,
      onUnarchiveThread: unarchiveSession,
      onDeleteThread: () => {},
    })

  // Build effective configOptions for new sessions: backend defaults with user-preferred overrides
  const newSessionConfigOptions = useMemo(() => {
    const defaults = defaultConfigOptions[newSessionAgentType] ?? []
    const prefs = newSessionDefaults[newSessionAgentType] ?? {}
    return defaults.map(opt => ({
      ...opt,
      currentValue: prefs[opt.id] ?? opt.currentValue,
    }))
  }, [defaultConfigOptions, newSessionAgentType, newSessionDefaults])

  // Show loading state while checking authentication
  if (authLoading || loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">{t('loading', 'Loading...')}</div>
      </div>
    )
  }

  // Show welcome page when not authenticated
  if (!isAuthenticated) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-3xl font-bold mb-4">{t('page.title', 'Agent Sessions')}</h1>
          <p className="text-muted-foreground text-lg mb-8 max-w-2xl">
            {t('page.description', 'Access your agent sessions for software development tasks.')}
          </p>
          <p className="text-muted-foreground">
            {t('page.signInHint', 'Please sign in using the button in the header to get started.')}
          </p>
        </div>
      </div>
    )
  }

  // Shared context value for AgentContextProvider — keeps the reference stable
  // across the multiple conditional render branches below.
  const agentContextValue = {
    sendPermissionResponse,
    pendingPermissions,
    connected,
    planEntries,
    workingDir: hasActiveSession ? (effectiveActiveSession?.workingDir ?? newSessionWorkingDir) : newSessionWorkingDir,
    onWorkingDirChange: hasActiveSession
      ? undefined
      : setNewSessionWorkingDir,
    agentType: activeSessionAgentType ?? newSessionAgentType,
    onAgentTypeChange: hasActiveSession
      ? undefined
      : (type: string) => setNewSessionAgentType(type as AgentType),
    configOptions: hasActiveSession ? sessionMeta?.configOptions : newSessionConfigOptions,
    onConfigOptionChange: hasActiveSession
      ? (configId: string, value: string) => sendSetConfigOption(configId, value)
      : (configId: string, value: string) => {
          setNewSessionDefaults(prev => ({
            ...prev,
            [newSessionAgentType]: { ...(prev[newSessionAgentType] ?? {}), [configId]: value },
          }))
        },
    sessionCommands: sessionMeta?.commands,
    sessionId: activeSessionId || "",
    hasActiveSession,
    historyLoadError,
    sessionError,
    subagentChildrenMap,
    pendingComposerText,
    clearPendingComposerText,
    resultCount,
  }

  // ─── Native app: single layout, no responsive split ─────────────────────────
  // The desktop/mobile conditional rendering below uses useIsMobile() to render
  // ChatInterface in one section or the other. On iPhone, rotating from portrait
  // (~390px) to landscape (~844px) crosses the 768px breakpoint, causing isMobile
  // to flip — which unmounts the current ChatInterface and mounts a new one,
  // losing all React state (fullscreen preview, scroll position, messages).
  // The native app always shows a single session, so bypass the split entirely.
  if (isNativeApp() && activeSessionId) {
    return (
      <AgentContextProvider value={agentContextValue}>
        <AssistantRuntimeProvider runtime={runtime}>
          <div className="flex h-full min-w-0">
            <div className="flex flex-1 flex-col bg-background overflow-hidden min-w-0 h-full">
              <AgentChat
                sessionId={activeSessionId}
                className="flex-1"
                onAttachmentsStorageIdChange={handleAttachmentsStorageIdChange}
                existingStorageId={effectiveActiveSession?.storageId ?? null}
              />
            </div>
          </div>
        </AssistantRuntimeProvider>
      </AgentContextProvider>
    )
  }

  // ─── Shared header for desktop sidebar and mobile list view ────────────────
  const SessionsHeader = ({ showCollapseButton = false }: { showCollapseButton?: boolean }) => (
    <div className="flex items-center justify-between border-b border-border px-3 py-2">
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

      {/* Center: Sessions ▾ | Auto segmented toggle.
          The Sessions pill carries a chevron that opens the status filter
          dropdown — the filter value itself is not rendered, only the chevron. */}
      <div className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
        {sidebarView === 'sessions' ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium bg-background text-foreground shadow-sm"
                title={`Filter · ${statusFilter}`}
              >
                {t('sidebar.sessions', 'Sessions')}
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              <DropdownMenuRadioGroup value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
                <DropdownMenuRadioItem value="active">{t('sidebar.filter.active', 'Active')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="all">{t('sidebar.filter.all', 'All')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="archived">{t('sidebar.filter.archived', 'Archived')}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <button
            onClick={() => navigate('/agent')}
            className="rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('sidebar.sessions', 'Sessions')}
          </button>
        )}
        <button
          onClick={() => navigate('/agent/auto')}
          className={cn(
            'rounded px-2.5 py-1 text-xs font-medium transition-colors',
            sidebarView === 'agents'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t('sidebar.auto', 'Auto')}
        </button>
      </div>

      {/* Right: context-aware action buttons */}
      <div className="flex items-center justify-end gap-0.5">
        {sidebarView === 'sessions' ? (
          sessionCreateNew && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                navigate('/agent')
                setShowNewSessionMobile(true)
              }}
              title="New session"
            >
              <Plus className="h-4 w-4" />
            </Button>
          )
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleCreateAgentWithAI}
            title="New auto agent"
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )

  // ─── Auto-agent editor (rendered in place of AgentChat when an agent
  //     is selected from the sidebar tree) ─────────────────────────────────
  const agentEditorPanel = editingAgentName ? (
    <div className="flex h-full min-h-0 flex-col">
      <AutoAgentEditor
        key={editingAgentName}
        name={editingAgentName}
        onSaved={handleAgentSaved}
        onDeleted={handleAgentDeleted}
        onEditWithAI={handleEditAgentWithAI}
        onBack={closeAgentEditor}
      />
    </div>
  ) : null

  // ─── Desktop layout ───────────────────────────────────────────────────────
  const desktopLayout = (
    <div className="flex flex-1 h-full min-w-0 overflow-hidden">
      {sessionSidebar ? (
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="agent-sidebar"
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
              'flex flex-col bg-muted/30 overflow-hidden',
              isSidebarCollapsed && 'hidden'
            )}
          >
            <SessionsHeader showCollapseButton />
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden p-2">
              {sidebarView === 'agents' ? (
                <AutoAgentTree
                  sessions={visibleSessions}
                  activeSessionId={activeSessionId}
                  editingAgentName={editingAgentName}
                  sessionStates={sessionStates}
                  sessionTriggerLabels={sessionTriggerLabels}
                  onSelectAgent={openAgentEditor}
                  onSelectSession={handleSelectSession}
                  refreshKey={agentsPanelRefresh}
                />
              ) : (
                <AgentSidebar
                  sessions={visibleSessions}
                  activeSessionId={activeSessionId}
                  sessionStates={sessionStates}
                  sessionSources={sessionSources}
                  sessionAgentNames={sessionAgentNames}
                  sessionTriggerLabels={sessionTriggerLabels}
                  hasMore={pagination.hasMore}
                  isLoadingMore={isLoadingMore}
                  onLoadMore={loadMoreSessions}
                  onSelectSession={handleSelectSession}
                  onRenameSession={updateSessionTitle}
                  onArchiveSession={archiveSession}
                  onUnarchiveSession={unarchiveSession}
                  onPinSession={handlePinSession}
                />
              )}
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
              {/* Top-right buttons: share */}
              {activeSessionId && effectiveActiveSession && !editingAgentName && (
                <div className="absolute top-2 right-2 z-20 flex items-center gap-1">
                  <ShareButton
                    session={effectiveActiveSession}
                    onUpdate={(fields) => updateSessionShare(activeSessionId, fields)}
                  />
                </div>
              )}
              {agentEditorPanel ? (
                agentEditorPanel
              ) : activeSessionId ? (
                <AgentChat
                  sessionId={activeSessionId}
                  className="flex-1"
                  onAttachmentsStorageIdChange={handleAttachmentsStorageIdChange}
                  existingStorageId={effectiveActiveSession?.storageId ?? null}
                />
              ) : (
                <AgentChat
                  key={`new-${newSessionComposerKey}`}
                  sessionId=""
                  className="flex-1 agent-bg"
                  onAttachmentsStorageIdChange={handleAttachmentsStorageIdChange}
                />
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        /* No sidebar — just the chat area (or auto-agents editor when active,
           used by the native iOS shell to deep-link into the editor with
           sessionSidebar=false). */
        <div className="flex-1 flex flex-col bg-background overflow-hidden min-w-0">
          {agentEditorPanel ? (
            agentEditorPanel
          ) : activeSessionId ? (
            <AgentChat
              sessionId={activeSessionId}
              className="flex-1"
              onAttachmentsStorageIdChange={handleAttachmentsStorageIdChange}
              existingStorageId={effectiveActiveSession?.storageId ?? null}
            />
          ) : (
            <AgentChat
              sessionId=""
              className="flex-1 agent-bg"
              onAttachmentsStorageIdChange={handleAttachmentsStorageIdChange}
            />
          )}
        </div>
      )}
    </div>
  )

  // ─── Mobile layout ────────────────────────────────────────────────────────
  const mobileLayout = (
    <div className="flex flex-1 h-full min-w-0 overflow-hidden">
      {agentEditorPanel ? (
        <div className="flex flex-1 flex-col bg-background overflow-hidden min-w-0">
          {agentEditorPanel}
        </div>
      ) : activeSessionId ? (
        /* Detail view: full-screen chat with floating back button */
        <div className="relative flex flex-1 flex-col bg-background overflow-hidden min-w-0">
          {sessionSidebar && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 left-2 z-20 h-10 w-10 rounded-full bg-background/80 backdrop-blur"
              onClick={goToList}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          {effectiveActiveSession && (
            <div className="absolute top-2 right-2 z-20">
              <ShareButton
                session={effectiveActiveSession}
                onUpdate={(fields) => updateSessionShare(activeSessionId, fields)}
              />
            </div>
          )}
          <AgentChat
            sessionId={activeSessionId}
            className="flex-1"
            onAttachmentsStorageIdChange={handleAttachmentsStorageIdChange}
            existingStorageId={effectiveActiveSession?.storageId ?? null}
          />
        </div>
      ) : sessionSidebar && showNewSessionMobile ? (
        /* New session view: full-screen chat input with back button */
        <div className="relative flex flex-1 flex-col agent-bg min-w-0">
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 left-2 z-20 h-10 w-10 rounded-full bg-background/80 backdrop-blur"
            onClick={() => window.history.back()}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <AgentChat
            key={`new-${newSessionComposerKey}`}
            sessionId=""
            className="flex-1"
            onAttachmentsStorageIdChange={handleAttachmentsStorageIdChange}
          />
        </div>
      ) : sessionSidebar ? (
        /* List view: full-screen session list (filtered by active tab) */
        <div className="flex flex-1 flex-col bg-muted/30 min-w-0 overflow-hidden">
          <SessionsHeader />
          <div className="flex-1 min-h-0 overflow-hidden p-2">
            {sidebarView === 'agents' ? (
              <AutoAgentTree
                sessions={visibleSessions}
                activeSessionId={activeSessionId}
                editingAgentName={editingAgentName}
                sessionStates={sessionStates}
                sessionTriggerLabels={sessionTriggerLabels}
                onSelectAgent={openAgentEditor}
                onSelectSession={handleSelectSession}
                refreshKey={agentsPanelRefresh}
              />
            ) : (
              <AgentSidebar
                sessions={visibleSessions}
                activeSessionId={activeSessionId}
                sessionStates={sessionStates}
                sessionSources={sessionSources}
                sessionAgentNames={sessionAgentNames}
                sessionTriggerLabels={sessionTriggerLabels}
                hasMore={pagination.hasMore}
                isLoadingMore={isLoadingMore}
                onLoadMore={loadMoreSessions}
                onSelectSession={handleSelectSession}
                onRenameSession={updateSessionTitle}
                onArchiveSession={archiveSession}
                onUnarchiveSession={unarchiveSession}
                onPinSession={handlePinSession}
              />
            )}
          </div>
        </div>
      ) : (
        /* No sidebar (hybrid app) — just the chat input */
        <AgentChat
          sessionId=""
          className="flex-1 agent-bg"
          onAttachmentsStorageIdChange={handleAttachmentsStorageIdChange}
        />
      )}
    </div>
  )

  return (
    <AgentContextProvider value={agentContextValue}>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
          {isMobile ? mobileLayout : desktopLayout}
        </div>
      </AssistantRuntimeProvider>
    </AgentContextProvider>
  )
}
