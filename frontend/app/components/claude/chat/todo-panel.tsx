import { useState } from 'react'
import { ChevronRight, ChevronDown, Circle, CircleDot, CheckCircle2 } from 'lucide-react'
import { cn } from '~/lib/utils'
import type { TodoItem } from '~/types/claude'

interface TodoPanelProps {
  todos: TodoItem[]
}

export function TodoPanel({ todos }: TodoPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)

  const completedCount = todos.filter((t) => t.status === 'completed').length
  const totalCount = todos.length
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  if (todos.length === 0) return null

  return (
    <div className="w-64 border-l border-border bg-muted/10 flex flex-col">
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="flex items-center gap-2 px-3 py-2 border-b border-border hover:bg-muted/50 transition-colors"
      >
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )}
        <span className="text-sm font-medium">Tasks</span>
        <span className="text-xs text-muted-foreground">
          ({completedCount}/{totalCount})
        </span>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">{progressPercent}%</span>
      </button>

      {/* Progress bar */}
      <div className="h-1 bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Todo list */}
      {!isCollapsed && (
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {todos.map((todo, index) => (
            <TodoItemView key={index} todo={todo} />
          ))}
        </div>
      )}
    </div>
  )
}

function TodoItemView({ todo }: { todo: TodoItem }) {
  const statusIcon = () => {
    switch (todo.status) {
      case 'pending':
        return <Circle className="h-4 w-4 text-muted-foreground" />
      case 'in_progress':
        return <CircleDot className="h-4 w-4 text-primary animate-pulse" />
      case 'completed':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />
    }
  }

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md px-2 py-1.5 text-sm',
        todo.status === 'in_progress' && 'bg-primary/10',
        todo.status === 'completed' && 'opacity-60'
      )}
    >
      <div className="mt-0.5">{statusIcon()}</div>
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            'truncate',
            todo.status === 'completed' && 'line-through text-muted-foreground'
          )}
        >
          {todo.status === 'in_progress' ? todo.activeForm : todo.content}
        </div>
      </div>
    </div>
  )
}
