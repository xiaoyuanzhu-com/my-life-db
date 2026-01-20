import { MessageDot } from '../message-dot'
import type { ToolCall, GlobToolParams, GlobToolResult } from '~/types/claude'

interface GlobToolViewProps {
  toolCall: ToolCall
}

export function GlobToolView({ toolCall }: GlobToolViewProps) {
  const params = toolCall.parameters as GlobToolParams
  const result = toolCall.result as GlobToolResult | string[] | undefined

  const files = Array.isArray(result) ? result : result?.files || []

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "Glob" + pattern */}
      <div className="flex items-start gap-2">
        <MessageDot status={toolCall.status} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Glob
          </span>
          <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.pattern}
            {params.path && <span className="opacity-70 ml-2">in {params.path}</span>}
          </span>
        </div>
      </div>

      {/* Summary: Found X files */}
      {files.length > 0 ? (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>Found {files.length} file{files.length !== 1 ? 's' : ''}</span>
        </div>
      ) : (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-tertiary)' }}>
          <span className="select-none">└</span>
          <span>No files found</span>
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
