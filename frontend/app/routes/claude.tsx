import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { useNavigate, useParams } from 'react-router'
import { SessionList } from '~/components/claude/session-list'
import { ChatInterface, ChatInput, BUILTIN_COMMANDS } from '~/components/claude/chat'
import { useWarmSession } from '~/components/claude/chat/hooks'
import { useSlashCommands } from '~/components/claude/chat/hooks/use-slash-commands'
import type { PermissionMode } from '~/components/claude/chat/permission-mode-selector'
import { Button } from '~/components/ui/button'
import { Plus, PanelLeftClose, PanelLeftOpen, ChevronDown, ArrowLeft } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '~/components/ui/resizable'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import { cn } from '~/lib/utils'
import { useAuth } from '~/contexts/auth-context'
import { useFeatureFlags } from '~/contexts/feature-flags-context'
import { useClaudeSessionNotifications } from '~/hooks/use-notifications'
import { api } from '~/lib/api'
import '@fontsource/jetbrains-mono'

const ClaudeLoginTerminal = lazy(() =>
  import('~/components/claude/claude-login-terminal').then(m => ({ default: m.ClaudeLoginTerminal }))
)

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
}

interface Pagination {
  hasMore: boolean
  nextCursor: string | null
  totalCount: number
}

type StatusFilter = 'all' | 'active' | 'archived'

export default function ClaudePage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const { sessionSidebar, sessionCreateNew } = useFeatureFlags()
  const navigate = useNavigate()
  const { sessionId: urlSessionId } = useParams()
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(urlSessionId || null)
  const [loading, setLoading] = useState(true)
  const [claudeLoggedIn, setClaudeLoggedIn] = useState<boolean | null>(null) // null = loading
  const touchStartX = useRef<number>(0)
  const touchEndX = useRef<number>(0)

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
  const [pendingInitialMessage, setPendingInitialMessage] = useState<string | null>(null)
  const [isCreatingSession, setIsCreatingSession] = useState(false)
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

  // Warm session: eagerly create a session to discover skills/slash commands.
  // Hidden from listings (ResultCount==0, no clients). Activated on first message.
  const warmSession = useWarmSession(
    newSessionWorkingDir,
    newSessionPermissionMode,
    !activeSessionId && isAuthenticated
  )
  // Merge warm session's init data (skills + dynamic commands) with builtins.
  // Falls back to BUILTIN_COMMANDS until the warm session's init message arrives.
  const warmSlashCommands = useSlashCommands(warmSession.initData)

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

      const response = await api.get(`/api/claude/sessions/all?${params}`)
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

      const response = await api.get(`/api/claude/sessions/all?${params}`)
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

  // Sync URL with active session
  useEffect(() => {
    if (activeSessionId) {
      // Update URL to include session ID
      navigate(`/claude/${activeSessionId}`, { replace: true })
    } else if (urlSessionId) {
      // URL has session ID but we don't have it set - navigate to base
      navigate('/claude', { replace: true })
    }
  }, [activeSessionId, urlSessionId, navigate])

  // Sync active session from URL (handles both mount and native bridge navigation)
  useEffect(() => {
    setActiveSessionId(urlSessionId || null)
  }, [urlSessionId])

  // Swipe gesture handler for mobile back navigation
  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
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
        setActiveSessionId(null)
      }

      // Reset for next gesture
      touchStartX.current = 0
      touchEndX.current = 0
    }

    // Only add listeners on mobile when viewing a session detail
    const isMobile = window.innerWidth < 768
    if (isMobile && activeSessionId) {
      document.addEventListener('touchstart', handleTouchStart, { passive: true })
      document.addEventListener('touchmove', handleTouchMove, { passive: true })
      document.addEventListener('touchend', handleTouchEnd)
    }

    return () => {
      document.removeEventListener('touchstart', handleTouchStart)
      document.removeEventListener('touchmove', handleTouchMove)
      document.removeEventListener('touchend', handleTouchEnd)
    }
  }, [activeSessionId])

  // Refresh session list when titles change (SSE from backend)
  // Uses refreshSessions for seamless background updates without loading flash
  useClaudeSessionNotifications({
    onSessionUpdated: refreshSessions,
    enabled: isAuthenticated,
  })

  // Check Claude Code CLI auth status
  useEffect(() => {
    api.get('/api/claude/auth-status')
      .then(res => res.json())
      .then(data => setClaudeLoggedIn(data.loggedIn))
      .catch(() => setClaudeLoggedIn(false))
  }, [])

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

      const response = await api.get(`/api/claude/sessions/all?${params}`)
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

  // Send first message: activate the warm session (or fallback to creating one inline).
  // The warm session was already created eagerly in the background — this just sets
  // the title via PATCH and transitions to the ChatInterface view.
  const createSessionWithMessage = async (message: string) => {
    if (!message || isCreatingSession) return

    setIsCreatingSession(true)
    try {
      // Activate the warm session — awaits creation if still in-flight, sets title via PATCH
      const sessionId = await warmSession.activate(message)

      // Build a minimal session object for the sidebar
      const newSession: Session = {
        id: sessionId,
        title: message,
        workingDir: newSessionWorkingDir,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        lastUserActivity: Date.now(),
        sessionState: 'idle',
        permissionMode: newSessionPermissionMode,
      }

      // Deduplicate: the session may already be in the list from an SSE-triggered
      // refresh that raced ahead of this optimistic add (warm session's JSONL write
      // fires an SSE event that can complete a full refresh cycle before the PATCH
      // response returns here). Filter first, then prepend.
      setSessions((prevSessions) => {
        const without = prevSessions.filter((s) => s.id !== newSession.id)
        return sortSessions([newSession, ...without])
      })
      // Set the pending message before switching to the session
      setPendingInitialMessage(message)
      setActiveSessionId(sessionId)
      // Clear the new-session draft from localStorage since message is now queued
      localStorage.removeItem('claude-input:new-session')
    } catch (error) {
      console.error('Warm session activate failed, creating inline:', error)
      // Fallback: create session the old way (handles case where warm session failed)
      try {
        const response = await api.post('/api/claude/sessions', {
          title: message,
          workingDir: newSessionWorkingDir,
          permissionMode: newSessionPermissionMode,
        })

        if (response.ok) {
          const newSession = await response.json()
          setSessions((prevSessions) => {
            const without = prevSessions.filter((s) => s.id !== newSession.id)
            return sortSessions([newSession, ...without])
          })
          setPendingInitialMessage(message)
          setActiveSessionId(newSession.id)
          localStorage.removeItem('claude-input:new-session')
        }
      } catch (fallbackError) {
        console.error('Fallback session creation also failed:', fallbackError)
      }
    } finally {
      setIsCreatingSession(false)
    }
  }

  const deleteSession = async (sessionId: string) => {
    try {
      const response = await api.delete(`/api/claude/sessions/${sessionId}`)

      if (response.ok) {
        setSessions(sessions.filter((s) => s.id !== sessionId))

        // If deleted session was active, switch to another
        if (activeSessionId === sessionId) {
          const remaining = sessions.filter((s) => s.id !== sessionId)
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null)
        }
      }
    } catch (error) {
      console.error('Failed to delete session:', error)
    }
  }

  const updateSessionTitle = async (sessionId: string, title: string) => {
    try {
      await api.patch(`/api/claude/sessions/${sessionId}`, { title })

      setSessions(
        sessions.map((s) => (s.id === sessionId ? { ...s, title } : s))
      )
    } catch (error) {
      console.error('Failed to update session:', error)
    }
  }

  const archiveSession = async (sessionId: string) => {
    try {
      const response = await api.post(`/api/claude/sessions/${sessionId}/archive`)

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
      const response = await api.post(`/api/claude/sessions/${sessionId}/unarchive`)

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
  }, [])

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

  // Show Claude Code login terminal when CLI is not authenticated
  if (claudeLoggedIn === false) {
    return (
      <Suspense fallback={
        <div className="flex h-full items-center justify-center">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }>
        <ClaudeLoginTerminal onLoginSuccess={() => setClaudeLoggedIn(true)} />
      </Suspense>
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
            onClick={() => setActiveSessionId(null)}
            title="New session"
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )

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
          <div className="relative flex flex-1 flex-col bg-background overflow-hidden min-w-0 animate-slide-in-right">
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
        ) : sessionSidebar ? (
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
        ) : (
          /* No sidebar (hybrid app) — just the chat input */
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
    </div>
  )
}
