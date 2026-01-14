import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { ClaudeTerminal } from '~/components/claude/terminal'
import { SessionList } from '~/components/claude/session-list'
import { Button } from '~/components/ui/button'
import { Plus, Menu } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '~/components/ui/sheet'

interface Session {
  id: string
  title: string
  workingDir: string
  status: 'active' | 'disconnected' | 'dead'
  createdAt: string
  lastActivity: string
}

export default function ClaudePage() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [showSidebar, setShowSidebar] = useState(true)
  const [showMobileSidebar, setShowMobileSidebar] = useState(false)
  const [loading, setLoading] = useState(true)
  const touchStartX = useRef<number>(0)
  const touchEndX = useRef<number>(0)

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
      const response = await fetch('/api/claude/sessions')
      const data = await response.json()
      setSessions(data.sessions || [])

      // Auto-select first session if none selected
      if (!activeSessionId && data.sessions?.length > 0) {
        setActiveSessionId(data.sessions[0].id)
      }
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
        setSessions([...sessions, newSession])
        setActiveSessionId(newSession.id)
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

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
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
        </div>

        <Button onClick={createSession} size="sm">
          <Plus className="mr-2 h-4 w-4" />
          New Session
        </Button>
      </div>

      {/* Mobile Action Buttons - Top Right, below status */}
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

        {/* Terminal area - fullscreen on mobile */}
        <div className="flex-1 bg-background overflow-hidden min-w-0">
          {activeSessionId ? (
            <ClaudeTerminal sessionId={activeSessionId} />
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
