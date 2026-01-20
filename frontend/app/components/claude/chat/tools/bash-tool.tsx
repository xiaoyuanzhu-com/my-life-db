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
    <div>
      {/* Description if provided */}
      {params?.description && (
        <div
          className="font-mono text-[13px] mb-2"
          style={{ color: 'var(--claude-text-secondary)' }}
        >
          {params.description}
        </div>
      )}

      {/* Command - Terminal style with dark background */}
      <div
        className="rounded-md p-3 mb-2"
        style={{ backgroundColor: '#1A1A1A' }}
      >
        <div className="flex items-start gap-2 font-mono text-[13px]">
          <span style={{ color: '#22C55E' }} className="select-none">$</span>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all" style={{ color: '#E8E8E8' }}>
            {params?.command || 'No command'}
          </pre>
        </div>
      </div>

      {/* Output */}
      {output && (
        <div
          className="rounded-md p-3 font-mono text-[13px] max-h-64 overflow-auto"
          style={{ backgroundColor: '#1A1A1A' }}
        >
          <pre className="whitespace-pre-wrap break-all" style={{ color: '#D1D1D1' }}>
            {output}
          </pre>
        </div>
      )}

      {/* Status footer */}
      {(exitCode !== undefined || duration) && (
        <div
          className="flex items-center gap-4 font-mono text-[13px] mt-2"
          style={{ color: 'var(--claude-text-tertiary)' }}
        >
          {exitCode !== undefined && (
            <span style={{ color: exitCode === 0 ? 'var(--claude-diff-add-fg)' : 'var(--claude-status-alert)' }}>
              exit {exitCode}
            </span>
          )}
          {duration && (
            <span>⏱ {(duration / 1000).toFixed(2)}s</span>
          )}
        </div>
      )}

      {/* Error */}
      {toolCall.error && (
        <div
          className="font-mono text-[13px] mt-2"
          style={{ color: 'var(--claude-status-alert)' }}
        >
          {toolCall.error}
        </div>
      )}
    </div>
  )
}
