import { MessageDot, toolStatusToDotType } from '../message-dot'
import type { ToolCall, ReadToolParams, ReadToolResult } from '~/types/claude'

interface ReadToolViewProps {
  toolCall: ToolCall
}

export function ReadToolView({ toolCall }: ReadToolViewProps) {
  const params = toolCall.parameters as ReadToolParams
  const result = toolCall.result as ReadToolResult | string | undefined

  // Extract line metadata from result
  const file = typeof result === 'object' ? result?.file : undefined
  const numLines = file?.numLines
  const totalLines = file?.totalLines
  const startLine = file?.startLine

  // Fall back to counting lines from content (for legacy/non-stripped messages)
  const content = typeof result === 'string'
    ? result
    : file?.content
  const fallbackLineCount = content ? content.split('\n').length : 0
  const linesRead = numLines ?? totalLines ?? fallbackLineCount

  // Partial read: only a subset of the file was read
  const isPartial = !!(totalLines && numLines && numLines < totalLines)

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

      {/* Summary: line range or line count */}
      {linesRead > 0 && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>
            {isPartial ? (
              <>
                Read line {startLine ?? 1}–{(startLine ?? 1) + numLines! - 1}
                <span style={{ color: 'var(--claude-text-tertiary)' }}>
                  {' '}({totalLines} total)
                </span>
              </>
            ) : (
              <>Read {linesRead} lines</>
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
