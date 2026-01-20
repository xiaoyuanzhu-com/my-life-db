import type { ToolCall, WebSearchToolParams, WebSearchToolResult } from '~/types/claude'

interface WebSearchToolViewProps {
  toolCall: ToolCall
}

export function WebSearchToolView({ toolCall }: WebSearchToolViewProps) {
  const params = toolCall.parameters as WebSearchToolParams
  const result = toolCall.result as WebSearchToolResult | undefined

  const resultCount = result?.results?.length || 0

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
      {/* Header: Status-colored bullet + "WebSearch" + query */}
      <div className="flex items-start gap-2">
        <span className="select-none" style={{ color: getBulletColor() }}>
          {bulletChar}
        </span>
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            WebSearch
          </span>
          <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.query}
          </span>
        </div>
      </div>

      {/* Summary: Found X results */}
      {resultCount > 0 ? (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>Found {resultCount} result{resultCount !== 1 ? 's' : ''}</span>
        </div>
      ) : toolCall.status === 'completed' ? (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-tertiary)' }}>
          <span className="select-none">└</span>
          <span>No results found</span>
        </div>
      ) : null}

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
