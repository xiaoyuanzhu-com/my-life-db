import { MessageDot, toolStatusToDotType } from '../message-dot'
import type { ToolCall, GrepToolParams, GrepToolResult } from '~/types/claude'

interface GrepToolViewProps {
  toolCall: ToolCall
}

export function GrepToolView({ toolCall }: GrepToolViewProps) {
  const params = toolCall.parameters as GrepToolParams
  const result = toolCall.result as GrepToolResult | string | undefined

  const files = typeof result === 'object' && result?.files ? result.files :
                typeof result === 'string' ? [result] : []

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "Grep" + pattern */}
      <div className="flex items-start gap-2">
        <MessageDot type={toolStatusToDotType(toolCall.status)} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Grep
          </span>
          <span className="ml-2 break-all" style={{ color: 'var(--claude-text-secondary)' }}>
            /{params.pattern}/
            {params.glob && <span className="opacity-70 ml-2">in {params.glob}</span>}
            {params.type && <span className="opacity-70 ml-2">type:{params.type}</span>}
          </span>
        </div>
      </div>

      {/* Summary: Found X matches */}
      {files.length > 0 ? (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>Found in {files.length} file{files.length !== 1 ? 's' : ''}</span>
        </div>
      ) : (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-tertiary)' }}>
          <span className="select-none">└</span>
          <span>No matches found</span>
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
