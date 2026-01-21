import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Check, X, Archive } from 'lucide-react'
import { cn } from '~/lib/utils'

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

interface SessionListProps {
  sessions: Session[]
  activeSessionId: string | null
  onSelect: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onRename: (sessionId: string, title: string) => void
  onArchive: (sessionId: string) => void
}

// Get the display title for a session with priority: customTitle > summary > title (firstPrompt)
function getSessionDisplayTitle(session: Session): string {
  if (session.customTitle) return session.customTitle
  if (session.summary) return session.summary
  return session.title || 'Untitled'
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onDelete,
  onRename,
  onArchive,
}: SessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  const startEdit = (session: Session) => {
    setEditingId(session.id)
    setEditTitle(getSessionDisplayTitle(session))
  }

  const saveEdit = () => {
    if (editingId && editTitle.trim()) {
      onRename(editingId, editTitle.trim())
    }
    setEditingId(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditTitle('')
  }

  return (
    <div className="h-full overflow-y-auto">
      {sessions.length === 0 ? (
        <div className="p-4 text-center text-sm text-muted-foreground">
          No sessions
        </div>
      ) : (
        sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                'group relative border-b border-border p-3 cursor-pointer transition-colors',
                activeSessionId === session.id
                  ? 'bg-primary/10'
                  : 'hover:bg-muted/50'
              )}
              onClick={() => onSelect(session.id)}
            >
              {editingId === session.id ? (
                <div className="flex items-center gap-1">
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit()
                      if (e.key === 'Escape') cancelEdit()
                    }}
                    className="h-7 text-sm"
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={(e) => {
                      e.stopPropagation()
                      saveEdit()
                    }}
                  >
                    <Check className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={(e) => {
                      e.stopPropagation()
                      cancelEdit()
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {session.isActive && (
                          <div className="h-2 w-2 rounded-full shrink-0 bg-green-500" />
                        )}
                        <h3 className="truncate text-sm font-medium text-foreground">
                          {getSessionDisplayTitle(session)}
                        </h3>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <p className="truncate">
                          {session.workingDir}
                        </p>
                        {session.messageCount !== undefined && session.messageCount > 0 && (
                          <span className="shrink-0">
                            • {session.messageCount} msgs
                          </span>
                        )}
                      </div>
                    </div>
                    {session.isActive && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation()
                          onArchive(session.id)
                        }}
                        title="Archive session"
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          ))
        )}
    </div>
  )
}
