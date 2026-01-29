import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router'
import { SessionList } from '~/components/claude/session-list'
import { ChatInterface } from '~/components/claude/chat'
import { ClaudeTerminal } from '~/components/claude/terminal'
import { ChatInputField } from '~/components/claude/chat/chat-input-field'
import { Button } from '~/components/ui/button'
import { Plus, Menu, MessageSquare, Terminal } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '~/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { useAuth } from '~/contexts/auth-context'
import { api } from '~/lib/api'
import '@fontsource/jetbrains-mono'

interface Session {
  id: string
  title: string // firstPrompt - fallback title
  summary?: string // Claude-generated 5-10 word title
  customTitle?: string // User-set custom title (via /title command)
  workingDir: string
  status: 'active' | 'disconnected' | 'dead' | 'archived'
  createdAt: string
  lastActivity: string
  isActive?: boolean
  messageCount?: number
  gitBranch?: string
}

interface Pagination {
  hasMore: boolean
  nextCursor: string | null
  totalCount: number
}

type StatusFilter = 'all' | 'active' | 'archived'

export default function ClaudePage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const { sessionId: urlSessionId } = useParams()
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(urlSessionId || null)
  const [showMobileSidebar, setShowMobileSidebar] = useState(false)
  const [loading, setLoading] = useState(true)
  const [uiMode, setUiMode] = useState<'chat' | 'terminal'>('chat')
  const touchStartX = useRef<number>(0)
  const touchEndX = useRef<number>(0)

  // Pagination state
  const [pagination, setPagination] = useState<Pagination>({
    hasMore: false,
    nextCursor: null,
    totalCount: 0,
  })
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  // New session input state (for empty state)
  const [newSessionInput, setNewSessionInput] = useState('')
  const [pendingInitialMessage, setPendingInitialMessage] = useState<string | null>(null)
  const [isCreatingSession, setIsCreatingSession] = useState(false)

  // Get active session
  const activeSession = sessions.find((s) => s.id === activeSessionId)

  // Load sessions on mount or when filter changes
  useEffect(() => {
    loadSessions()
  }, [statusFilter])

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

  // Initialize active session from URL on mount
  useEffect(() => {
    if (urlSessionId) {
      setActiveSessionId(urlSessionId)
    }
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
      // 2. Swipe was leftward (start X > end X)
      // 3. Swipe distance was significant (> 100px)
      if (touchStartX.current > 0 && touchStartX.current - touchEndX.current > 100) {
        navigate(-1)
      }

      // Reset for next gesture
      touchStartX.current = 0
      touchEndX.current = 0
    }

    // Only add listeners on mobile
    const isMobile = window.innerWidth < 768
    if (isMobile) {
      document.addEventListener('touchstart', handleTouchStart, { passive: true })
      document.addEventListener('touchmove', handleTouchMove, { passive: true })
      document.addEventListener('touchend', handleTouchEnd)
    }

    return () => {
      if (isMobile) {
        document.removeEventListener('touchstart', handleTouchStart)
        document.removeEventListener('touchmove', handleTouchMove)
        document.removeEventListener('touchend', handleTouchEnd)
      }
    }
  }, [navigate])

  // Sort sessions: active first, then by last activity
  const sortSessions = (sessionList: Session[]): Session[] => {
    return [...sessionList].sort((a: Session, b: Session) => {
      // Active sessions come first
      if (a.isActive && !b.isActive) return -1
      if (!a.isActive && b.isActive) return 1

      // Within same type, sort by lastActivity
      return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
    })
  }

  const loadSessions = async () => {
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
  }

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
  }, [pagination.hasMore, pagination.nextCursor, isLoadingMore, statusFilter])

  const createSession = async () => {
    try {
      const response = await api.post('/api/claude/sessions', {
        title: `Session ${sessions.length + 1}`,
        workingDir: '', // Use default
      })

      if (response.ok) {
        const newSession = await response.json()
        // Add new session at the beginning (most recent first)
        // Mark as active since it was just created
        setSessions((prevSessions) => [
          { ...newSession, isActive: true },
          ...prevSessions,
        ])
        setActiveSessionId(newSession.id)
      }
    } catch (error) {
      console.error('Failed to create session:', error)
    }
  }

  // Create session and send initial message (for empty state flow)
  const createSessionWithMessage = async () => {
    const message = newSessionInput.trim()
    if (!message || isCreatingSession) return

    setIsCreatingSession(true)
    try {
      const response = await api.post('/api/claude/sessions', {
        title: `Session ${sessions.length + 1}`,
        workingDir: '', // Use default
      })

      if (response.ok) {
        const newSession = await response.json()
        setSessions((prevSessions) => [
          { ...newSession, isActive: true },
          ...prevSessions,
        ])
        // Set the pending message before switching to the session
        setPendingInitialMessage(message)
        setNewSessionInput('')
        setActiveSessionId(newSession.id)
      }
    } catch (error) {
      console.error('Failed to create session:', error)
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
      const response = await api.post(`/api/claude/sessions/${sessionId}/deactivate`)

      if (response.ok) {
        // Mark session as archived in the UI
        setSessions(
          sessions.map((s) =>
            s.id === sessionId ? { ...s, isActive: false, status: 'archived' as const } : s
          )
        )

        // If archived session was active, switch to first active session or first session
        if (activeSessionId === sessionId) {
          const remaining = sessions.filter((s) => s.id !== sessionId && s.isActive)
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null)
        }
      }
    } catch (error) {
      console.error('Failed to archive session:', error)
    }
  }

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

  return (
    <div className="flex h-full">
      {/* Left Column: Sessions Sidebar */}
      <div className="hidden md:flex md:w-[30rem] border-r border-border flex-col bg-muted/30">
        {/* Sessions Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-1">
            <h2
              className="text-sm font-semibold cursor-pointer hover:text-primary transition-colors"
              onClick={() => setActiveSessionId(null)}
              title="Clear selection"
            >
              Sessions
              {pagination.totalCount > 0 && (
                <span className="ml-1 text-xs text-muted-foreground font-normal">
                  ({pagination.totalCount})
                </span>
              )}
            </h2>
            <Select value={statusFilter} onValueChange={(value: StatusFilter) => setStatusFilter(value)}>
              <SelectTrigger className="h-6 w-20 text-xs px-2 gap-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All</SelectItem>
                <SelectItem value="active" className="text-xs">Active</SelectItem>
                <SelectItem value="archived" className="text-xs">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setUiMode(uiMode === 'chat' ? 'terminal' : 'chat')}
              title={uiMode === 'chat' ? 'Switch to Terminal' : 'Switch to Chat'}
            >
              {uiMode === 'chat' ? (
                <Terminal className="h-4 w-4" />
              ) : (
                <MessageSquare className="h-4 w-4" />
              )}
            </Button>
            <Button onClick={createSession} size="sm">
              New
            </Button>
          </div>
        </div>

        {/* Sessions List */}
        <div className="flex-1 overflow-hidden">
          <SessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={setActiveSessionId}
            onDelete={deleteSession}
            onRename={updateSessionTitle}
            onArchive={archiveSession}
            hasMore={pagination.hasMore}
            isLoadingMore={isLoadingMore}
            onLoadMore={loadMoreSessions}
          />
        </div>
      </div>

      {/* Mobile Sidebar Sheet */}
      <Sheet open={showMobileSidebar} onOpenChange={setShowMobileSidebar}>
        <SheetContent side="left" className="w-[280px] p-0 md:hidden flex flex-col">
          <SheetHeader className="px-4 py-3 border-b">
            <div className="flex items-center gap-1">
              <SheetTitle>
                Sessions
                {pagination.totalCount > 0 && (
                  <span className="ml-1 text-xs text-muted-foreground font-normal">
                    ({pagination.totalCount})
                  </span>
                )}
              </SheetTitle>
              <Select value={statusFilter} onValueChange={(value: StatusFilter) => setStatusFilter(value)}>
                <SelectTrigger className="h-6 w-20 text-xs px-2 gap-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">All</SelectItem>
                  <SelectItem value="active" className="text-xs">Active</SelectItem>
                  <SelectItem value="archived" className="text-xs">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </SheetHeader>
          <div className="flex-1 overflow-hidden">
            <SessionList
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={(id) => {
                setActiveSessionId(id)
                setShowMobileSidebar(false)
              }}
              onDelete={deleteSession}
              onRename={updateSessionTitle}
              onArchive={archiveSession}
              hasMore={pagination.hasMore}
              isLoadingMore={isLoadingMore}
              onLoadMore={loadMoreSessions}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile Action Buttons - Top Right */}
      <div className="md:hidden fixed top-12 right-2 z-20 flex gap-2">
        <Button
          size="icon"
          variant="ghost"
          className="h-10 w-10 rounded-md bg-background/80 backdrop-blur"
          onClick={() => setShowMobileSidebar(true)}
        >
          <Menu className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-10 w-10 rounded-md bg-background/80 backdrop-blur"
          onClick={createSession}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Right Column: Chat Interface or Terminal */}
      <div className="flex-1 flex flex-col bg-background overflow-hidden min-w-0">
        {activeSessionId && activeSession ? (
          uiMode === 'chat' ? (
            <ChatInterface
              sessionId={activeSessionId}
              sessionName={activeSession.title || 'Session'}
              workingDir={activeSession.workingDir}
              isActive={activeSession.isActive}
              onSessionNameChange={(name) => updateSessionTitle(activeSessionId, name)}
              refreshSessions={loadSessions}
              initialMessage={pendingInitialMessage ?? undefined}
              onInitialMessageSent={() => setPendingInitialMessage(null)}
            />
          ) : (
            <ClaudeTerminal sessionId={activeSessionId} />
          )
        ) : (
          <div className="flex h-full flex-col claude-bg">
            {/* Empty message area */}
            <div className="flex-1" />
            {/* Input at bottom */}
            <div className="pb-4">
              <div className="w-full max-w-4xl mx-auto px-4 md:px-6">
                <div
                  className="border border-border rounded-xl overflow-hidden"
                  style={{ backgroundColor: 'var(--claude-bg-subtle)' }}
                >
                  <ChatInputField
                    content={newSessionInput}
                    onChange={setNewSessionInput}
                    onSend={createSessionWithMessage}
                    disabled={isCreatingSession}
                    placeholder="Start a new conversation..."
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
