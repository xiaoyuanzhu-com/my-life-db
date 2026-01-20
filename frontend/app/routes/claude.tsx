import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { SessionTab } from '~/components/claude/session-tab'
import { SessionList } from '~/components/claude/session-list'
import { ChatInterface } from '~/components/claude/chat'
import { Button } from '~/components/ui/button'
import { Plus, Menu, Terminal, MessageSquare } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '~/components/ui/sheet'
import { useAuth } from '~/contexts/auth-context'
import { cn } from '~/lib/utils'
import '@fontsource/jetbrains-mono'

type UIMode = 'terminal' | 'chat'

interface Session {
  id: string
  title: string
  workingDir: string
  status: 'active' | 'disconnected' | 'dead' | 'archived'
  createdAt: string
  lastActivity: string
  isActive?: boolean
  messageCount?: number
  gitBranch?: string
}

export default function ClaudePage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [showSidebar, setShowSidebar] = useState(true)
  const [showMobileSidebar, setShowMobileSidebar] = useState(false)
  const [loading, setLoading] = useState(true)
  const [uiMode, setUiMode] = useState<UIMode>('chat') // Default to new chat UI
  const touchStartX = useRef<number>(0)
  const touchEndX = useRef<number>(0)

  // Get active session
  const activeSession = sessions.find((s) => s.id === activeSessionId)

  // Load sessions on mount
  useEffect(() => {
    loadSessions()
  }, [])

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

  const loadSessions = async () => {
    try {
      // Fetch all sessions (both active and historical)
      const response = await fetch('/api/claude/sessions/all')
      const data = await response.json()
      const allSessions = data.sessions || []

      // Sort: active sessions first, then by last activity (most recent first)
      const sortedSessions = allSessions.sort((a: Session, b: Session) => {
        // Active sessions come first
        if (a.isActive && !b.isActive) return -1
        if (!a.isActive && b.isActive) return 1

        // Within same type, sort by lastActivity
        return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      })

      setSessions(sortedSessions)

      // Auto-select first ACTIVE session ONLY on initial load
      // Use callback form to get current state, preventing override of user's selection
      setActiveSessionId((currentId) => {
        console.log('[loadSessions] currentId:', currentId, 'sessions:', sortedSessions?.map((s: Session) => s.id))
        // If user already selected/created a session, preserve it
        if (currentId !== null) {
          console.log('[loadSessions] preserving currentId:', currentId)
          return currentId
        }
        // Otherwise auto-select first active session if available
        const firstActiveSession = sortedSessions.find((s: Session) => s.isActive)
        const firstId = firstActiveSession ? firstActiveSession.id : null
        console.log('[loadSessions] auto-selecting first active session:', firstId)
        return firstId
      })
    } catch (error) {
      console.error('Failed to load sessions:', error)
    } finally {
      setLoading(false)
    }
  }

  const createSession = async () => {
    try {
      const response = await fetch('/api/claude/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Session ${sessions.length + 1}`,
          workingDir: '', // Use default
        }),
      })

      if (response.ok) {
        const newSession = await response.json()
        console.log('[createSession] created new session:', newSession.id)
        setSessions([...sessions, newSession])
        setActiveSessionId(newSession.id)
        console.log('[createSession] set activeSessionId to:', newSession.id)
      }
    } catch (error) {
      console.error('Failed to create session:', error)
    }
  }

  const deleteSession = async (sessionId: string) => {
    try {
      const response = await fetch(`/api/claude/sessions/${sessionId}`, {
        method: 'DELETE',
      })

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
      await fetch(`/api/claude/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })

      setSessions(
        sessions.map((s) => (s.id === sessionId ? { ...s, title } : s))
      )
    } catch (error) {
      console.error('Failed to update session:', error)
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
    <div className="flex h-full flex-col">
      {/* Desktop Header - hidden on mobile */}
      <div className="hidden md:flex items-center justify-between border-b border-border bg-background px-4 py-2">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowSidebar(!showSidebar)}
          >
            <Menu className="h-4 w-4" />
          </Button>
          <h1 className="text-lg font-semibold">Claude Code</h1>

          {/* UI Mode Toggle */}
          <div className="ml-4 flex items-center rounded-lg border border-border p-0.5">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-7 px-2',
                uiMode === 'chat' && 'bg-muted'
              )}
              onClick={() => setUiMode('chat')}
              title="Chat UI"
            >
              <MessageSquare className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-7 px-2',
                uiMode === 'terminal' && 'bg-muted'
              )}
              onClick={() => setUiMode('terminal')}
              title="Terminal UI"
            >
              <Terminal className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <Button onClick={createSession} size="sm">
          <Plus className="mr-2 h-4 w-4" />
          New Session
        </Button>
      </div>

      {/* Mobile Action Buttons - Top Right, below status */}
      <div className="md:hidden fixed top-12 right-2 z-20 flex gap-2">
        {/* UI Mode Toggle (mobile) */}
        <Button
          size="icon"
          variant="ghost"
          className="h-10 w-10 rounded-md bg-background/80 backdrop-blur"
          onClick={() => setUiMode(uiMode === 'chat' ? 'terminal' : 'chat')}
          title={uiMode === 'chat' ? 'Switch to Terminal' : 'Switch to Chat'}
        >
          {uiMode === 'chat' ? (
            <Terminal className="h-4 w-4" />
          ) : (
            <MessageSquare className="h-4 w-4" />
          )}
        </Button>
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

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Desktop Sidebar */}
        {showSidebar && (
          <div className="hidden md:block">
            <SessionList
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={setActiveSessionId}
              onDelete={deleteSession}
              onRename={updateSessionTitle}
            />
          </div>
        )}

        {/* Mobile Sidebar Sheet */}
        <Sheet open={showMobileSidebar} onOpenChange={setShowMobileSidebar}>
          <SheetContent side="left" className="w-[280px] p-0 md:hidden">
            <SheetHeader className="px-4 py-3 border-b">
              <SheetTitle>Sessions</SheetTitle>
            </SheetHeader>
            <SessionList
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={(id) => {
                setActiveSessionId(id)
                setShowMobileSidebar(false)
              }}
              onDelete={deleteSession}
              onRename={updateSessionTitle}
            />
          </SheetContent>
        </Sheet>

        {/* Main area - Terminal or Chat UI */}
        <div className="flex-1 bg-background overflow-hidden min-w-0">
          {sessions.length > 0 && activeSessionId ? (
            // Check if session is historical (archived)
            activeSession?.isActive === false ? (
              // Historical session - show chat history in read-only mode
              <ChatInterface
                sessionId={activeSessionId}
                sessionName={activeSession?.title || 'Session'}
                workingDir={activeSession?.workingDir}
                onSessionNameChange={(name) => updateSessionTitle(activeSessionId, name)}
                readOnly={true}
              />
            ) : uiMode === 'terminal' ? (
              // Active session - Terminal UI
              <>
                {sessions.map((session) => (
                  <SessionTab
                    key={session.id}
                    sessionId={session.id}
                    isActive={session.id === activeSessionId}
                  />
                ))}
              </>
            ) : (
              // Active session - Chat UI
              <ChatInterface
                sessionId={activeSessionId}
                sessionName={activeSession?.title || 'Session'}
                workingDir={activeSession?.workingDir}
                onSessionNameChange={(name) => updateSessionTitle(activeSessionId, name)}
                readOnly={false}
              />
            )
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-muted-foreground mb-4">No sessions</p>
                <Button onClick={createSession}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create First Session
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
