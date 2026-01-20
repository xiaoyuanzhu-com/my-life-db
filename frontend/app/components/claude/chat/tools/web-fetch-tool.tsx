import type { ToolCall, WebFetchToolParams } from '~/types/claude'

interface WebFetchToolViewProps {
  toolCall: ToolCall
}

export function WebFetchToolView({ toolCall }: WebFetchToolViewProps) {
  const params = toolCall.parameters as WebFetchToolParams
  const result = toolCall.result as string | undefined

  // Extract domain from URL
  let domain = ''
  try {
    domain = new URL(params.url).hostname
  } catch {
    domain = params.url
  }

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
      {/* Header: Status-colored bullet + "WebFetch" + URL */}
      <div className="flex items-start gap-2">
        <span className="select-none" style={{ color: getBulletColor() }}>
          {bulletChar}
        </span>
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            WebFetch
          </span>
          <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
            {domain}
          </span>
        </div>
      </div>

      {/* Summary: Fetched content */}
      {result && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>Fetched {result.length} characters</span>
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
