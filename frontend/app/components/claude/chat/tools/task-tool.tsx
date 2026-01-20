import { MessageDot } from '../message-dot'
import type { ToolCall, TaskToolParams } from '~/types/claude'

interface TaskToolViewProps {
  toolCall: ToolCall
}

export function TaskToolView({ toolCall }: TaskToolViewProps) {
  const params = toolCall.parameters as TaskToolParams
  const result = toolCall.result as string | undefined

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "Task" + description */}
      <div className="flex items-start gap-2">
        <MessageDot status={toolCall.status} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Task
          </span>
          <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.description} ({params.subagent_type})
            {params.model && <span className="opacity-70 ml-1">[{params.model}]</span>}
            {params.run_in_background && <span className="opacity-70 ml-1">[background]</span>}
          </span>
        </div>
      </div>

      {/* Status indicator */}
      {toolCall.status === 'running' && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>Agent is working...</span>
        </div>
      )}

      {/* Result summary */}
      {result && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>Completed</span>
        </div>
      )}

      {/* Error */}
      {toolCall.error && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-status-alert)' }}>
          <span className="select-none">└</span>
          <div className="flex-1 min-w-0">{toolCall.error}</div>
        </div>
      )}
    </div>
  )
}
