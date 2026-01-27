import { useState } from 'react'
import { MessageDot } from '../message-dot'
import type { ToolCall, BashToolParams, BashToolResult } from '~/types/claude'
import type { BashProgressMessage } from '../session-messages'

interface BashToolViewProps {
  toolCall: ToolCall
  /** Map from tool_use ID to bash progress messages */
  bashProgressMap?: Map<string, BashProgressMessage[]>
}

const MAX_LINES = 5
const MAX_CHARS = 500

// Truncate text to max lines OR max chars, whichever is shorter
function truncateText(text: string): { display: string; truncated: boolean } {
  const lines = text.split('\n')
  let display = lines.slice(0, MAX_LINES).join('\n')
  let truncated = lines.length > MAX_LINES

  if (display.length > MAX_CHARS) {
    display = [...display].slice(0, MAX_CHARS).join('')
    truncated = true
  } else if (text.length > display.length) {
    truncated = true
  }

  return { display, truncated }
}

export function BashToolView({ toolCall, bashProgressMap }: BashToolViewProps) {
  const params = (toolCall.parameters || {}) as BashToolParams
  const result = toolCall.result as BashToolResult | string | undefined
  const [expanded, setExpanded] = useState(false)

  // Get progress messages for this tool call
  const progressMessages = bashProgressMap?.get(toolCall.id) || []
  const latestProgress = progressMessages.length > 0 ? progressMessages[progressMessages.length - 1] : null

  // Parse result
  const output = typeof result === 'string' ? result : result?.output
  const exitCode = typeof result === 'object' ? result?.exitCode : undefined

  // Get full text content
  const commandText = params?.command || 'No command'
  const outputText = output || ''
  const errorText = toolCall.error || ''

  // Truncate each section
  const command = truncateText(commandText)
  const outputResult = truncateText(outputText)
  const errorResult = truncateText(errorText)

  const isTruncated = command.truncated || outputResult.truncated || errorResult.truncated

  // Determine status for dot - bash has special logic for exit codes
  // If we have progress but no result, it's running
  const dotStatus = (() => {
    if (toolCall.error || toolCall.status === 'failed') return 'failed' as const
    if (exitCode !== undefined && exitCode !== 0) return 'failed' as const
    if (latestProgress && !result) return 'running' as const
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
            className="p-2"
            style={{ backgroundColor: 'var(--claude-bg-secondary)' }}
          >
            <pre
              className="p-2 whitespace-pre-wrap break-all"
              style={{ color: 'var(--claude-text-primary)' }}
            >
              {expanded ? commandText : command.display}
            </pre>
          </div>

          {/* Progress indicator (shown when running) */}
          {latestProgress && !result && (
            <div
              className="px-3 py-2 flex items-center gap-2"
              style={{
                borderTop: '1px solid var(--claude-border-light)',
                color: 'var(--claude-text-secondary)',
              }}
            >
              <span className="animate-pulse">⏳</span>
              <span>Running... {latestProgress.data?.elapsedTimeSeconds}s</span>
              {latestProgress.data?.totalLines !== undefined && latestProgress.data.totalLines > 0 && (
                <span className="text-[12px]">({latestProgress.data.totalLines} lines)</span>
              )}
            </div>
          )}

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
                {expanded ? outputText : outputResult.display}
              </div>
            </div>
          )}

          {/* Error */}
          {toolCall.error && (
            <div
              className="px-3 py-2 whitespace-pre-wrap break-all"
              style={{
                borderTop: '1px solid var(--claude-border-light)',
                color: 'var(--claude-status-alert)',
              }}
            >
              {expanded ? errorText : errorResult.display}
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
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  )
}
