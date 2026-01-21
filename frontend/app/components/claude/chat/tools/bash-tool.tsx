import { MessageDot } from '../message-dot'
import type { ToolCall, BashToolParams, BashToolResult } from '~/types/claude'

interface BashToolViewProps {
  toolCall: ToolCall
}

export function BashToolView({ toolCall }: BashToolViewProps) {
  const params = (toolCall.parameters || {}) as BashToolParams
  const result = toolCall.result as BashToolResult | string | undefined

  // Parse result
  const output = typeof result === 'string' ? result : result?.output
  const exitCode = typeof result === 'object' ? result?.exitCode : undefined

  // Determine status for dot - bash has special logic for exit codes
  const dotStatus = (() => {
    if (toolCall.error || toolCall.status === 'failed') return 'failed' as const
    if (exitCode !== undefined && exitCode !== 0) return 'failed' as const
    return toolCall.status
  })()

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Line 1: Status-colored bullet + "Bash" + description */}
      <div className="flex items-start gap-2">
        <MessageDot status={dotStatus} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Bash
          </span>
          {params?.description && (
            <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
              {params.description}
            </span>
          )}
        </div>
      </div>

      {/* Line 2: Command with L-shaped indent */}
      <div className="flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
        <span className="select-none">{output || toolCall.error ? '│' : '└'}</span>
        <pre className="flex-1 min-w-0 whitespace-pre-wrap break-all overflow-x-auto">
          {params?.command || 'No command'}
        </pre>
      </div>

      {/* Line 3: Output with L-shaped indent */}
      {output && (
        <div className="flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <div className="flex-1 min-w-0 whitespace-pre-wrap break-all">
            {output}
          </div>
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
