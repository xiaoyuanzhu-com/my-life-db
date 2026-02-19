import { MessageDot, toolStatusToDotType } from '../message-dot'
import type { ToolCall, ReadToolParams, ReadToolResult } from '~/types/claude'

interface ReadToolViewProps {
  toolCall: ToolCall
}

export function ReadToolView({ toolCall }: ReadToolViewProps) {
  const params = toolCall.parameters as ReadToolParams
  const result = toolCall.result as ReadToolResult | string | undefined

  // Get line count from result metadata
  const lineCount = typeof result === 'object'
    ? (result?.file?.totalLines ?? result?.file?.numLines)
    : undefined

  // Fall back to counting lines from content (for legacy/non-stripped messages)
  const content = typeof result === 'string'
    ? result
    : result?.file?.content
  const actualLineCount = lineCount || (content ? content.split('\n').length : 0)

  // Check if truncated
  const isTruncated = typeof result === 'object' && result?.file?.totalLines && result?.file?.numLines &&
    result.file.numLines < result.file.totalLines

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "Read" + file path */}
      <div className="flex items-start gap-2 w-full text-left">
        <MessageDot type={toolStatusToDotType(toolCall.status)} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Read
          </span>
          <span className="ml-2 break-all" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.file_path}
          </span>
        </div>
      </div>

      {/* Summary: Read X lines */}
      {actualLineCount > 0 && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>
            Read {actualLineCount} lines
            {isTruncated && (
              <span style={{ color: 'var(--claude-text-tertiary)' }}>
                {' '}(truncated from {result?.file?.totalLines})
              </span>
            )}
          </span>
        </div>
      )}

      {/* Error */}
      {toolCall.error && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-status-alert)' }}>
          <span className="select-none">└</span>
          <span>{toolCall.error}</span>
        </div>
      )}
    </div>
  )
}
