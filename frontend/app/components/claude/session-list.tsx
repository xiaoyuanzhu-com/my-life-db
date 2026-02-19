import { useState, useRef, useEffect, useCallback } from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Check, X, Archive, ArchiveRestore, Loader2 } from 'lucide-react'
import { cn } from '~/lib/utils'

export type SessionState = 'idle' | 'working' | 'ready' | 'archived'

export interface Session {
  id: string
  title: string // firstPrompt - fallback title
  summary?: string // Claude-generated 5-10 word title
  customTitle?: string // User-set custom title (via /title command)
  workingDir: string
  sessionState: SessionState // unified state: idle, working, ready, archived
  createdAt: string
  lastActivity: string
  lastUserActivity?: string
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
  onUnarchive: (sessionId: string) => void
  // Pagination props
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void
}

// Max chars to render in DOM - prevents performance issues with very long titles
// CSS truncate handles visual truncation; this caps extreme cases (e.g., 1000+ char prompts)
const MAX_TITLE_CHARS = 120

// ─── Display helpers ─────────────────────────────────────────────────────────

// Get the display title for a session
// Backend computes the proper title with priority: customTitle > summary > firstUserPrompt
function getSessionDisplayTitle(session: Session): { display: string; full: string } {
  const full = session.title || 'Untitled'
  if (full.length <= MAX_TITLE_CHARS) {
    return { display: full, full }
  }
  return { display: full.slice(0, MAX_TITLE_CHARS) + '…', full }
}

// Format relative time (e.g., "3h ago", "2d ago")
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay < 30) return `${diffDay}d ago`
  return date.toLocaleDateString()
}

// ─── Unread dot indicator ────────────────────────────────────────────────────

function UnreadIndicator({ state }: { state: 'working' | 'ready' }) {
  // Working: solid amber dot — Claude is still generating
  // Ready:   solid green dot — Claude finished, waiting for user
  return (
    <span
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        state === 'working' ? 'bg-amber-500' : 'bg-emerald-500'
      )}
      title={state === 'working' ? 'Claude is working' : 'New messages — waiting for you'}
    />
  )
}

// ─── Component ───────────────────────────────────────────────────────────────

export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onDelete: _onDelete,
  onRename,
  onArchive,
  onUnarchive,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
}: SessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null)

  const _startEdit = (session: Session) => {
    setEditingId(session.id)
    setEditTitle(getSessionDisplayTitle(session).full)
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

  // Infinite scroll using Intersection Observer
  const handleLoadMore = useCallback(() => {
    if (hasMore && !isLoadingMore && onLoadMore) {
      onLoadMore()
    }
  }, [hasMore, isLoadingMore, onLoadMore])

  useEffect(() => {
    const trigger = loadMoreTriggerRef.current
    if (!trigger || !onLoadMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          handleLoadMore()
        }
      },
      {
        root: listRef.current,
        rootMargin: '100px', // Trigger 100px before reaching the bottom
        threshold: 0,
      }
    )

    observer.observe(trigger)

    return () => {
      observer.disconnect()
    }
  }, [handleLoadMore, onLoadMore])

  return (
    <div ref={listRef} className="h-full overflow-y-auto">
      {sessions.length === 0 ? (
        <div className="p-4 text-center text-sm text-muted-foreground">
          No sessions
        </div>
      ) : (
        <>
          {sessions.map((session) => {
            // Show unread dot for active/waiting sessions that aren't currently being viewed
            const { sessionState } = session
            const showDot = (sessionState === 'working' || sessionState === 'ready')
              && activeSessionId !== session.id

            return (
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
                        <div className="flex items-center gap-1.5">
                          <h3
                            className={cn(
                              'truncate text-sm font-medium text-foreground',
                              sessionState === 'archived' && 'opacity-60'
                            )}
                            title={getSessionDisplayTitle(session).full}
                          >
                            {getSessionDisplayTitle(session).display}
                          </h3>
                          {/* Fixed-width dot column — keeps dots vertically aligned across rows */}
                          <span className="w-2 shrink-0 flex items-center">
                            {showDot && (
                              <UnreadIndicator state={sessionState as 'working' | 'ready'} />
                            )}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="truncate">
                            {session.workingDir}
                          </span>
                          <span className="shrink-0">
                            • {formatRelativeTime(session.lastUserActivity || session.lastActivity)}
                          </span>
                          {session.messageCount !== undefined && session.messageCount > 0 && (
                            <span className="shrink-0">
                              • {session.messageCount} msgs
                            </span>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation()
                          sessionState === 'archived' ? onUnarchive(session.id) : onArchive(session.id)
                        }}
                        title={sessionState === 'archived' ? 'Unarchive session' : 'Archive session'}
                      >
                        {sessionState === 'archived' ? (
                          <ArchiveRestore className="h-3.5 w-3.5" />
                        ) : (
                          <Archive className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )
          })}

          {/* Load more trigger element - invisible sentinel for Intersection Observer */}
          <div ref={loadMoreTriggerRef} className="h-1" />

          {/* Loading indicator */}
          {isLoadingMore && (
            <div className="flex items-center justify-center p-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span className="text-sm">Loading more...</span>
            </div>
          )}

          {/* End of list indicator */}
          {!hasMore && sessions.length > 0 && (
            <div className="p-3 text-center text-xs text-muted-foreground">
              — End of sessions —
            </div>
          )}
        </>
      )}
    </div>
  )
}
