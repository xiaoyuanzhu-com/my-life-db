import { useState } from 'react'
import { MessageDot } from '../message-dot'
import type { ToolCall, BashToolParams, BashToolResult } from '~/types/claude'

interface BashToolViewProps {
  toolCall: ToolCall
}

const MAX_LINES = 5

export function BashToolView({ toolCall }: BashToolViewProps) {
  const params = (toolCall.parameters || {}) as BashToolParams
  const result = toolCall.result as BashToolResult | string | undefined
  const [expanded, setExpanded] = useState(false)

  // Parse result
  const output = typeof result === 'string' ? result : result?.output
  const exitCode = typeof result === 'object' ? result?.exitCode : undefined

  // Split into lines for truncation
  const commandLines = (params?.command || 'No command').split('\n')
  const outputLines = output ? output.split('\n') : []

  // Check if truncation is needed
  const isCommandTruncated = commandLines.length > MAX_LINES
  const isOutputTruncated = outputLines.length > MAX_LINES
  const isTruncated = isCommandTruncated || isOutputTruncated

  // Get lines to display
  const displayCommandLines = expanded ? commandLines : commandLines.slice(0, MAX_LINES)
  const displayOutputLines = expanded ? outputLines : outputLines.slice(0, MAX_LINES)

  const totalHiddenCount =
    Math.max(0, commandLines.length - MAX_LINES) +
    Math.max(0, outputLines.length - MAX_LINES)

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

      {/* Command and Output container */}
      <div
        className="rounded-md overflow-hidden"
        style={{ border: '1px solid var(--claude-border-light)' }}
      >
        <div
          className={expanded && isTruncated ? 'overflow-y-auto' : ''}
          style={expanded && isTruncated ? { maxHeight: '60vh' } : {}}
        >
          {/* Command */}
          <div
            className="px-3 py-2"
            style={{ backgroundColor: 'var(--claude-bg-secondary)' }}
          >
            <pre
              className="whitespace-pre-wrap break-all"
              style={{ color: 'var(--claude-text-primary)' }}
            >
              {displayCommandLines.join('\n')}
            </pre>
          </div>

          {/* Output */}
          {output && (
            <div
              className="px-3 py-2"
              style={{
                borderTop: '1px solid var(--claude-border-light)',
                color: 'var(--claude-text-secondary)',
              }}
            >
              <div className="whitespace-pre-wrap break-all">
                {displayOutputLines.join('\n')}
              </div>
            </div>
          )}
        </div>

        {/* Expand/Collapse button */}
        {isTruncated && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full py-1.5 text-[12px] cursor-pointer hover:opacity-80 transition-opacity"
            style={{
              backgroundColor: 'var(--claude-bg-secondary)',
              color: 'var(--claude-text-secondary)',
              borderTop: '1px solid var(--claude-border-light)',
            }}
          >
            {expanded ? 'Show less' : `Show ${totalHiddenCount} more lines`}
          </button>
        )}
      </div>

      {/* Error */}
      {toolCall.error && (() => {
        const errorLines = toolCall.error.split('\n')
        const isErrorTruncated = errorLines.length > MAX_LINES
        const displayErrorLines = expanded ? errorLines : errorLines.slice(0, MAX_LINES)
        const hiddenErrorCount = errorLines.length - MAX_LINES

        return (
          <div
            className="mt-2 rounded-md overflow-hidden"
            style={{ border: '1px solid var(--claude-status-alert)' }}
          >
            <div
              className={expanded && isErrorTruncated ? 'overflow-y-auto' : ''}
              style={expanded && isErrorTruncated ? { maxHeight: '60vh' } : {}}
            >
              <div
                className="px-3 py-2 whitespace-pre-wrap break-all"
                style={{ color: 'var(--claude-status-alert)' }}
              >
                {displayErrorLines.join('\n')}
              </div>
            </div>
            {isErrorTruncated && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="w-full py-1.5 text-[12px] cursor-pointer hover:opacity-80 transition-opacity"
                style={{
                  backgroundColor: 'var(--claude-bg-secondary)',
                  color: 'var(--claude-text-secondary)',
                  borderTop: '1px solid var(--claude-status-alert)',
                }}
              >
                {expanded ? 'Show less' : `Show ${hiddenErrorCount} more lines`}
              </button>
            )}
          </div>
        )
      })()}
    </div>
  )
}
