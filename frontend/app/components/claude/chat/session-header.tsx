import { useState } from 'react'
import { Input } from '~/components/ui/input'
import { Button } from '~/components/ui/button'
import { Edit2, Check, X, FolderOpen, Archive } from 'lucide-react'
import { cn } from '~/lib/utils'

interface SessionHeaderProps {
  sessionName: string
  workingDir?: string
  status: 'connecting' | 'connected' | 'disconnected'
  tokenUsage: {
    used: number
    limit: number
  }
  onNameChange?: (name: string) => void
  readOnly?: boolean
}

export function SessionHeader({
  sessionName,
  workingDir,
  status,
  tokenUsage,
  onNameChange,
  readOnly = false,
}: SessionHeaderProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(sessionName)

  const handleSave = () => {
    if (editName.trim() && onNameChange) {
      onNameChange(editName.trim())
    }
    setIsEditing(false)
  }

  const handleCancel = () => {
    setEditName(sessionName)
    setIsEditing(false)
  }

  const usagePercent = Math.round((tokenUsage.used / tokenUsage.limit) * 100)

  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2">
      {/* Left: Session name and working dir */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {isEditing ? (
          <div className="flex items-center gap-1">
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave()
                if (e.key === 'Escape') handleCancel()
              }}
              className="h-7 w-48 text-sm"
              autoFocus
            />
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleSave}>
              <Check className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCancel}>
              <X className="h-3 w-3" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 min-w-0">
            {readOnly && <Archive className="h-4 w-4 text-muted-foreground" />}
            <h1 className="text-sm font-medium text-foreground truncate">{sessionName}</h1>
            {readOnly && (
              <span className="text-xs text-muted-foreground">(Historical)</span>
            )}
            {onNameChange && !readOnly && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 opacity-50 hover:opacity-100"
                onClick={() => setIsEditing(true)}
              >
                <Edit2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}

        {workingDir && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground truncate">
            <FolderOpen className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{workingDir}</span>
          </div>
        )}
      </div>

      {/* Right: Status and token usage */}
      <div className="flex items-center gap-4">
        {/* Token usage bar */}
        <div className="hidden sm:flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {tokenUsage.used.toLocaleString()} / {tokenUsage.limit.toLocaleString()}
          </span>
          <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                usagePercent > 90
                  ? 'bg-destructive'
                  : usagePercent > 70
                    ? 'bg-yellow-500'
                    : 'bg-primary'
              )}
              style={{ width: `${Math.min(usagePercent, 100)}%` }}
            />
          </div>
        </div>

        {/* Connection status */}
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'h-2 w-2 rounded-full',
              status === 'connected' && 'bg-green-500',
              status === 'connecting' && 'bg-yellow-500 animate-pulse',
              status === 'disconnected' && 'bg-red-500'
            )}
          />
          <span className="text-xs text-muted-foreground capitalize hidden sm:inline">
            {status}
          </span>
        </div>
      </div>
    </div>
  )
}
