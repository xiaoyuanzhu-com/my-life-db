import { useState, useEffect } from 'react'
import { ClaudeTerminal } from '~/components/claude/terminal'
import { SessionList } from '~/components/claude/session-list'
import { Button } from '~/components/ui/button'
import { Plus, Menu } from 'lucide-react'

interface Session {
  id: string
  title: string
  workingDir: string
  status: 'active' | 'disconnected' | 'dead'
  createdAt: string
  lastActivity: string
}

export default function ClaudePage() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [showSidebar, setShowSidebar] = useState(true)
  const [loading, setLoading] = useState(true)

  // Load sessions on mount
  useEffect(() => {
    loadSessions()
  }, [])

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
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-background px-4 py-2">
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

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {showSidebar && (
          <SessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={setActiveSessionId}
            onDelete={deleteSession}
            onRename={updateSessionTitle}
          />
        )}

        {/* Terminal area */}
        <div className="flex-1 bg-background">
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
