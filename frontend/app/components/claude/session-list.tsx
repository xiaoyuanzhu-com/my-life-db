import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Trash2, Edit2, Check, X } from 'lucide-react'
import { cn } from '~/lib/utils'

interface Session {
  id: string
  title: string
  workingDir: string
  status: 'active' | 'disconnected' | 'dead'
  createdAt: string
  lastActivity: string
}

interface SessionListProps {
  sessions: Session[]
  activeSessionId: string | null
  onSelect: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onRename: (sessionId: string, title: string) => void
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onDelete,
  onRename,
}: SessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  const startEdit = (session: Session) => {
    setEditingId(session.id)
    setEditTitle(session.title)
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
    <div className="w-64 border-r border-border bg-muted/10">
      <div className="border-b border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">Sessions</h2>
      </div>

      <div className="overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No sessions
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                'group relative border-b border-border p-3 hover:bg-muted/50 cursor-pointer transition-colors',
                activeSessionId === session.id && 'bg-muted'
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
                        <div
                          className={cn(
                            'h-2 w-2 rounded-full',
                            session.status === 'active' && 'bg-green-500',
                            session.status === 'disconnected' && 'bg-yellow-500',
                            session.status === 'dead' && 'bg-red-500'
                          )}
                        />
                        <h3 className="truncate text-sm font-medium text-foreground">
                          {session.title}
                        </h3>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {session.workingDir}
                      </p>
                    </div>

                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={(e) => {
                          e.stopPropagation()
                          startEdit(session)
                        }}
                      >
                        <Edit2 className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm('Delete this session?')) {
                            onDelete(session.id)
                          }
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
