import { MessageDot } from '../message-dot'
import type { ToolCall, WriteToolParams } from '~/types/claude'

interface WriteToolViewProps {
  toolCall: ToolCall
}

export function WriteToolView({ toolCall }: WriteToolViewProps) {
  const params = toolCall.parameters as WriteToolParams

  const lines = params.content.split('\n')

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "Write" + file path */}
      <div className="flex items-start gap-2">
        <MessageDot status={toolCall.status} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Write
          </span>
          <span className="ml-2 break-all" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.file_path}
          </span>
        </div>
      </div>

      {/* Summary: Created file (only show if no error) */}
      {!toolCall.error && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>Created file ({lines.length} lines)</span>
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
