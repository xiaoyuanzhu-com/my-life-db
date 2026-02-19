import { MessageDot, toolStatusToDotType } from '../message-dot'
import type { ToolCall, TodoWriteParams, TodoItem } from '~/types/claude'

interface TodoToolViewProps {
  toolCall: ToolCall
}

export function TodoToolView({ toolCall }: TodoToolViewProps) {
  const params = toolCall.parameters as TodoWriteParams
  const todos = params.todos || []

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "Update Todos" */}
      <div className="flex items-start gap-2 mb-2">
        <MessageDot type={toolStatusToDotType(toolCall.status)} />
        <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
          Update Todos
        </span>
      </div>

      {/* Todo list with tree structure */}
      <div className="ml-4 space-y-0.5">
        {todos.map((todo, index) => (
          <TodoItemRow key={index} todo={todo} isFirst={index === 0} />
        ))}
      </div>

      {/* Error */}
      {toolCall.error && (
        <div
          className="font-mono text-[13px] mt-2"
          style={{ color: 'var(--claude-status-alert)' }}
        >
          {toolCall.error}
        </div>
      )}
    </div>
  )
}

function TodoItemRow({ todo, isFirst }: { todo: TodoItem; isFirst: boolean }) {
  const isCompleted = todo.status === 'completed'
  const isInProgress = todo.status === 'in_progress'

  // Tree connector: L for first, space for rest
  const treeConnector = isFirst ? 'L' : '\u00A0'

  // Checkbox style based on status
  const checkbox = isCompleted ? '☑' : '☐'

  return (
    <div
      className="flex items-start gap-1.5"
      style={{
        color: isCompleted ? 'var(--claude-text-tertiary)' : 'var(--claude-text-primary)',
        textDecoration: isCompleted ? 'line-through' : 'none',
      }}
    >
      <span className="select-none opacity-40">{treeConnector}</span>
      <span className="select-none">{checkbox}</span>
      <span className={isInProgress ? 'font-medium' : ''}>
        {isInProgress ? todo.activeForm : todo.content}
      </span>
    </div>
  )
}
