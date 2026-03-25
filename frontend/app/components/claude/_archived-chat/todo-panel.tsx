import { useState } from 'react'
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
    <div
      className="w-72 flex flex-col"
      style={{
        borderLeft: '1px solid var(--claude-border-light)',
        backgroundColor: 'var(--claude-bg-subtle)',
      }}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="flex items-center gap-2 px-4 py-3 font-mono text-[13px] font-medium hover:opacity-80 transition-opacity"
        style={{
          color: 'var(--claude-text-secondary)',
          borderBottom: '1px solid var(--claude-border-light)',
        }}
      >
        <span className="select-none">{isCollapsed ? '▶' : '▼'}</span>
        <span>Tasks ({completedCount}/{totalCount})</span>
        <span className="flex-1" />
        <span>{progressPercent}%</span>
      </button>

      {/* Progress bar */}
      <div
        className="h-1"
        style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
      >
        <div
          className="h-full transition-all"
          style={{
            width: `${progressPercent}%`,
            backgroundColor: 'var(--claude-diff-add-fg)',
          }}
        />
      </div>

      {/* Todo list - uses CSS grid for smooth collapse animation */}
      <div className={`collapsible-grid ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="collapsible-grid-content">
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {todos.map((todo, index) => (
              <TodoItemView key={index} todo={todo} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function TodoItemView({ todo }: { todo: TodoItem }) {
  // Status indicators: ○ pending, ◐ in progress, ● completed
  const statusIcon = () => {
    switch (todo.status) {
      case 'pending':
        return <span style={{ color: 'var(--claude-text-tertiary)' }}>○</span>
      case 'in_progress':
        return <span style={{ color: 'var(--claude-diff-add-fg)' }}>◐</span>
      case 'completed':
        return <span style={{ color: 'var(--claude-diff-add-fg)' }}>●</span>
    }
  }

  return (
    <div className="flex items-start gap-2 text-[15px] leading-relaxed">
      <div className="mt-0.5">{statusIcon()}</div>
      <div
        className="flex-1 min-w-0"
        style={{
          color: todo.status === 'completed' ? 'var(--claude-text-tertiary)' : 'var(--claude-text-primary)',
          textDecoration: todo.status === 'completed' ? 'line-through' : 'none',
        }}
      >
        {todo.status === 'in_progress' ? todo.activeForm : todo.content}
      </div>
    </div>
  )
}
