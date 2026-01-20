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

  // Determine bullet color based on status
  const getBulletColor = () => {
    if (toolCall.error || toolCall.status === 'failed') return '#D92D20' // Red
    if (toolCall.status === 'running') return '#F59E0B' // Orange/Yellow
    if (toolCall.status === 'pending') return '#9CA3AF' // Gray
    if (toolCall.status === 'permission_required') return '#F59E0B' // Orange
    return '#22C55E' // Green for success
  }

  // Use outline for pending state
  const bulletChar = toolCall.status === 'pending' ? '○' : '●'

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "Read" + file path */}
      <div className="flex items-start gap-2">
        <span className="select-none" style={{ color: getBulletColor() }}>
          {bulletChar}
        </span>
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
