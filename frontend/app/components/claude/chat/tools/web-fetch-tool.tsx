import { MessageDot } from '../message-dot'
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

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "WebFetch" + URL */}
      <div className="flex items-start gap-2">
        <MessageDot status={toolCall.status} />
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
