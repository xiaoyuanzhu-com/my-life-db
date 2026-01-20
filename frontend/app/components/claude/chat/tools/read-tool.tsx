import { MessageDot } from '../message-dot'
import type { ToolCall, ReadToolParams, ReadToolResult } from '~/types/claude'

interface ReadToolViewProps {
  toolCall: ToolCall
}

export function ReadToolView({ toolCall }: ReadToolViewProps) {
  const params = toolCall.parameters as ReadToolParams
  const result = toolCall.result as ReadToolResult | string | undefined

  const content = typeof result === 'string' ? result : result?.content
  const lineCount = typeof result === 'object' ? result?.lineCount : undefined

  // Count lines in content for summary
  const actualLineCount = lineCount || (content ? content.split('\n').length : 0)

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "Read" + file path */}
      <div className="flex items-start gap-2">
        <MessageDot status={toolCall.status} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Read
          </span>
          <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.file_path}
          </span>
        </div>
      </div>

      {/* Summary: Read X lines */}
      {actualLineCount > 0 && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>Read {actualLineCount} lines</span>
        </div>
      )}

      {/* Truncation notice */}
      {typeof result === 'object' && result?.truncated && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-tertiary)' }}>
          <span className="select-none">└</span>
          <span>Content truncated ({result.lineCount} total lines)</span>
        </div>
      )}
    </div>
  )
}
