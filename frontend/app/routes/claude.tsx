import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { ThreadList } from '~/components/assistant-ui/thread-list'
import type { PermissionMode } from '~/components/agent/permission-mode-selector'
import type { AgentType } from '~/components/agent/agent-type-selector'
import { AgentChat } from '~/components/agent/agent-chat'
import { AgentContextProvider } from '~/components/agent/agent-context'
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
import { useClaudeSessionNotifications } from '~/hooks/use-notifications'
import { useIsMobile } from '~/hooks/use-is-mobile'
import { api } from '~/lib/api'
import { isNativeApp } from '~/lib/native-bridge'
import { fetchWithRefresh } from '~/lib/fetch-with-refresh'
import '@fontsource/jetbrains-mono'

interface Session {
  id: string
  title: string // firstPrompt - fallback title
  summary?: string // Claude-generated 5-10 word title
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
}

interface Pagination {
  hasMore: boolean
  nextCursor: string | null
  totalCount: number
}

type StatusFilter = 'all' | 'active' | 'archived'

function ShareButton({ session, onUpdate }: { session: Session; onUpdate: (s: Partial<Session>) => void }) {
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
            <DialogTitle>Share session</DialogTitle>
            <DialogDescription>
              Anyone with the link can view this session (read-only).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Share toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Public link</span>
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
                      Copied
                    </>
                  ) : (
                    'Copy link'
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

export default function ClaudePage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const { sessionSidebar, sessionCreateNew } = useFeatureFlags()
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const { sessionId: urlSessionId } = useParams()
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(urlSessionId || null)
  const [loading, setLoading] = useState(true)
  const touchStartX = useRef<number>(0)
  const touchEndX = useRef<number>(0)
  const prevActiveSessionIdRef = useRef<string | null>(activeSessionId)

  // Pagination state
  const [pagination, setPagination] = useState<Pagination>({
    hasMore: false,
    nextCursor: null,
    totalCount: 0,
  })
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('claude-session-filter')
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
      return localStorage.getItem('claude-sidebar-collapsed') === 'true'
    }
    return false
  })

  const sidebarPanelRef = useRef<ImperativePanelHandle>(null)

  // New session state (for empty state)
  // Initialize from localStorage if available
  const [newSessionWorkingDir, setNewSessionWorkingDir] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('claude-last-working-dir') || ''
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
  const [newSessionPermissionMode, setNewSessionPermissionMode] = useState<PermissionMode>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('claude-permission-mode')
      if (saved === 'default' || saved === 'acceptEdits' || saved === 'plan' || saved === 'bypassPermissions') {
        return saved
      }
    }
    return 'default'
  })
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
      localStorage.setItem('claude-last-working-dir', newSessionWorkingDir)
    }
  }, [newSessionWorkingDir])

  // Persist session filter to localStorage
  useEffect(() => {
    localStorage.setItem('claude-session-filter', statusFilter)
  }, [statusFilter])

  // Persist permission mode to localStorage
  useEffect(() => {
    localStorage.setItem('claude-permission-mode', newSessionPermissionMode)
  }, [newSessionPermissionMode])

  // Persist agent type to localStorage
  useEffect(() => {
    localStorage.setItem('mld-agent-type', newSessionAgentType)
  }, [newSessionAgentType])

  // Persist sidebar collapsed state
  useEffect(() => {
    localStorage.setItem('claude-sidebar-collapsed', String(isSidebarCollapsed))
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

  // Sync permission mode from localStorage when returning to new-session view
  // (mode may have been changed inside an active session's ChatInterface)
  useEffect(() => {
    if (!activeSessionId) {
      const saved = localStorage.getItem('claude-permission-mode') as PermissionMode | null
      if (saved && saved !== newSessionPermissionMode) {
        setNewSessionPermissionMode(saved)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only sync when activeSessionId changes
  }, [activeSessionId])

  // Sort sessions by last USER activity (most recent first)
  // Uses lastUserActivity (only updated on user input) instead of lastActivity
  // (updated on any file write) to prevent sessions from jumping when Claude responds
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
        limit: '20',
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
        limit: '20',
        status: statusFilter,
      })

      const response = await api.get(`/api/agent/sessions/all?${params}`)
      const data = await response.json()
      const newSessionList: Session[] = data.sessions || []

      setSessions((prevSessions) => {
        const newMap = new Map(newSessionList.map((s) => [s.id, s]))

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
      }
      setSessions((prev) => {
        if (prev.some((s) => s.id === session.id)) return prev
        return [...prev, session]
      })
    }).catch(() => {})

    return () => { cancelled = true }
  }, [activeSessionId, loading])

  // Sync URL with active session
  useEffect(() => {
    const prevId = prevActiveSessionIdRef.current
    prevActiveSessionIdRef.current = activeSessionId

    if (activeSessionId) {
      // Skip if URL already matches (e.g. after browser back/forward popstate)
      if (urlSessionId === activeSessionId) return
      // Push a new history entry when navigating from list → detail (prevId was null).
      // This lets the browser's native swipe-back gesture return to the session list.
      // Use replace when switching between sessions to avoid stacking history entries.
      //
      // IMPORTANT: In the native app (iOS/macOS), ALWAYS replace. The native
      // NavigationStack owns back navigation via its interactive pop gesture.
      // If we push browser history entries here, the WebView consumes the
      // edge-swipe to go back in browser history instead of letting the
      // NavigationStack pop — causing the user to land on a stale empty page
      // instead of the session list.
      const useReplace = isNativeApp() || prevId != null
      navigate(`/claude/${activeSessionId}`, { replace: useReplace })
    } else if (urlSessionId) {
      // Going back to list — replace so we don't duplicate the list entry
      navigate('/claude', { replace: true })
    }
  }, [activeSessionId, urlSessionId, navigate])

  // Sync active session from URL (handles both mount and native bridge navigation)
  useEffect(() => {
    setActiveSessionId(urlSessionId || null)
  }, [urlSessionId])

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
          setActiveSessionId(null)
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
  }, [activeSessionId, showNewSessionMobile])

  // Refresh session list when titles change (SSE from backend)
  // Uses refreshSessions for seamless background updates without loading flash
  useClaudeSessionNotifications({
    onSessionUpdated: refreshSessions,
    enabled: isAuthenticated,
  })

  // Load more sessions (infinite scroll)
  const loadMoreSessions = useCallback(async () => {
    if (!pagination.hasMore || isLoadingMore || !pagination.nextCursor) return

    try {
      setIsLoadingMore(true)
      const params = new URLSearchParams({
        limit: '20',
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
      const response = await api.post('/api/agent/sessions', {
        title: message,
        message: message,
        workingDir: newSessionWorkingDir,
        permissionMode: newSessionPermissionMode,
        agentType: newSessionAgentType,
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
        permissionMode: newSessionPermissionMode,
        agentType: session.agentType ?? newSessionAgentType,
      }

      setSessions((prevSessions) => {
        const without = prevSessions.filter((s) => s.id !== newSession.id)
        return sortSessions([newSession, ...without])
      })
      setActiveSessionId(session.id)
      setShowNewSessionMobile(false)
      localStorage.removeItem('claude-input:new-session')
    } catch (error) {
      console.error('Failed to create session:', error)
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
        setSessions(
          sessions.map((s) =>
            s.id === sessionId ? { ...s, sessionState: 'archived' as const } : s
          )
        )
      }
    } catch (error) {
      console.error('Failed to archive session:', error)
    }
  }

  const unarchiveSession = async (sessionId: string) => {
    try {
      const response = await api.post(`/api/agent/sessions/${sessionId}/unarchive`)

      if (response.ok) {
        setSessions(
          sessions.map((s) =>
            s.id === sessionId ? { ...s, sessionState: 'idle' as const } : s
          )
        )
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
    setActiveSessionId(sessionId)
    setShowNewSessionMobile(false)
  }, [])

  // Update share fields on a session (called by ShareButton)
  const updateSessionShare = useCallback((sessionId: string, fields: Partial<Session>) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, ...fields } : s))
    )
  }, [])

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
  const { runtime, connected, sessionMeta, pendingPermissions, planEntries, sendPermissionResponse, sendSetMode, historyLoadError, sessionError } =
    useAgentRuntime({
      sessionId: activeSessionId || "",
      token: "",
      enabled: hasActiveSession,
      onSend: onSendForRuntime,
      sessions,
      activeSessionId,
      onSwitchToThread: handleSelectSession,
      onSwitchToNewThread: () => setActiveSessionId(null),
      onRenameThread: updateSessionTitle,
      onArchiveThread: archiveSession,
      onUnarchiveThread: unarchiveSession,
      onDeleteThread: () => {},
    })

  // Show loading state while checking authentication
  if (authLoading || loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  // Show welcome page when not authenticated
  if (!isAuthenticated) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-3xl font-bold mb-4">Claude Code Sessions</h1>
          <p className="text-muted-foreground text-lg mb-8 max-w-2xl">
            Access your Claude Code interactive sessions for software development tasks.
          </p>
          <p className="text-muted-foreground">
            Please sign in using the button in the header to get started.
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
    sendSetMode,
    workingDir: newSessionWorkingDir,
    onWorkingDirChange: setNewSessionWorkingDir,
    permissionMode: newSessionPermissionMode,
    availableModes: sessionMeta?.availableModes,
    onPermissionModeChange: (mode: string) => {
      setNewSessionPermissionMode(mode as PermissionMode)
      if (hasActiveSession) sendSetMode(mode)
    },
    agentType: activeSessionAgentType ?? newSessionAgentType,
    onAgentTypeChange: hasActiveSession
      ? undefined
      : (type: string) => setNewSessionAgentType(type as AgentType),
    sessionCommands: sessionMeta?.commands,
    hasActiveSession,
    historyLoadError,
    sessionError,
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
              />
            </div>
          </div>
        </AssistantRuntimeProvider>
      </AgentContextProvider>
    )
  }

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
            onClick={() => {
              setActiveSessionId(null)
              setShowNewSessionMobile(true)
            }}
            title="New session"
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <AgentContextProvider value={agentContextValue}>
    <AssistantRuntimeProvider runtime={runtime}>
    <div className="flex h-full min-w-0">
      {/* ── Desktop: Resizable sidebar + chat ── */}
      <div className="hidden md:flex md:flex-1 h-full min-w-0">
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
              <div className="flex-1 overflow-hidden p-2">
                <ThreadList activeSessionId={activeSessionId} />
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
                {activeSessionId && effectiveActiveSession && (
                  <div className="absolute top-2 right-2 z-20 flex items-center gap-1">
                    <ShareButton
                      session={effectiveActiveSession}
                      onUpdate={(fields) => updateSessionShare(activeSessionId, fields)}
                    />
                  </div>
                )}
                {activeSessionId && !isMobile ? (
                  <AgentChat
                    sessionId={activeSessionId}
                    className="flex-1"
                  />
                ) : !activeSessionId ? (
                  <AgentChat
                    sessionId=""
                    className="flex-1 claude-bg"
                  />
                ) : null}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          /* No sidebar — just the chat area */
          <div className="flex-1 flex flex-col bg-background overflow-hidden min-w-0">
            {activeSessionId && !isMobile ? (
              <AgentChat
                sessionId={activeSessionId}
                className="flex-1"
              />
            ) : !activeSessionId ? (
              <AgentChat
                sessionId=""
                className="flex-1 claude-bg"
              />
            ) : null}
          </div>
        )}
      </div>

      {/* ── Mobile: Stack navigation ── */}
      <div className="flex md:hidden flex-1 h-full min-w-0 overflow-hidden">
        {activeSessionId && isMobile ? (
          /* Detail view: full-screen chat with floating back button */
          <div className="relative flex flex-1 flex-col bg-background overflow-hidden min-w-0">
            {sessionSidebar && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-2 left-2 z-20 h-10 w-10 rounded-full bg-background/80 backdrop-blur"
                onClick={() => setActiveSessionId(null)}
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
            />
          </div>
        ) : !activeSessionId && sessionSidebar && showNewSessionMobile ? (
          /* New session view: full-screen chat input with back button */
          <div className="relative flex flex-1 flex-col claude-bg min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 left-2 z-20 h-10 w-10 rounded-full bg-background/80 backdrop-blur"
              onClick={() => window.history.back()}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <AgentChat
              sessionId=""
              className="flex-1"
            />
          </div>
        ) : sessionSidebar ? (
          /* List view: full-screen session list */
          <div className="flex flex-1 flex-col bg-muted/30 min-w-0">
            <SessionsHeader />
            <div className="flex-1 overflow-hidden p-2">
              <ThreadList activeSessionId={activeSessionId} />
            </div>
          </div>
        ) : (
          /* No sidebar (hybrid app) — just the chat input */
          <AgentChat
            sessionId=""
            className="flex-1 claude-bg"
          />
        )}
      </div>
    </div>
    </AssistantRuntimeProvider>
    </AgentContextProvider>
  )
}
