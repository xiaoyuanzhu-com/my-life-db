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
  const duration = typeof result === 'object' ? result?.duration : toolCall.duration

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Green bullet + "Bash" + command */}
      <div className="flex items-start gap-2">
        <span className="text-[#22C55E] select-none">●</span>
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Bash
          </span>
          <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
            {params?.command || 'No command'}
          </span>
        </div>
      </div>

      {/* Output with L-shaped indent */}
      {output && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <pre className="flex-1 min-w-0 whitespace-pre-wrap break-all overflow-x-auto">
            {output}
          </pre>
        </div>
      )}

      {/* Status footer with L-shaped indent */}
      {(exitCode !== undefined || duration) && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-tertiary)' }}>
          <span className="select-none">└</span>
          <div className="flex items-center gap-4">
            {exitCode !== undefined && (
              <span style={{ color: exitCode === 0 ? 'var(--claude-diff-add-fg)' : 'var(--claude-status-alert)' }}>
                exit {exitCode}
              </span>
            )}
            {duration && (
              <span>⏱ {(duration / 1000).toFixed(2)}s</span>
            )}
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
