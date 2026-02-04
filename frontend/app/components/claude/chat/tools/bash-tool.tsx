import { useState } from 'react'
import { MessageDot } from '../message-dot'
import type { ToolCall, BashToolParams, BashToolResult } from '~/types/claude'
import type { BashProgressMessage } from '../session-messages'

interface BashToolViewProps {
  toolCall: ToolCall
  /** Map from tool_use ID to bash progress messages */
  bashProgressMap?: Map<string, BashProgressMessage[]>
}

export function BashToolView({ toolCall, bashProgressMap }: BashToolViewProps) {
  const params = (toolCall.parameters || {}) as BashToolParams
  const result = toolCall.result as BashToolResult | string | undefined
  const [expanded, setExpanded] = useState(false)

  // Get progress messages for this tool call
  const progressMessages = bashProgressMap?.get(toolCall.id) || []
  const latestProgress =
    progressMessages.length > 0 ? progressMessages[progressMessages.length - 1] : null

  // Parse result
  const output = typeof result === 'string' ? result : result?.output
  const exitCode = typeof result === 'object' ? result?.exitCode : undefined

  const commandText = params?.command || 'No command'
  const outputText = output || ''
  const errorText = toolCall.error || ''
  const hasOutput = outputText || errorText

  // Determine status for dot
  const dotStatus = (() => {
    if (toolCall.error || toolCall.status === 'failed') return 'failed' as const
    if (exitCode !== undefined && exitCode !== 0) return 'failed' as const
    if (latestProgress && !result) return 'running' as const
    return toolCall.status
  })()

  // Build summary line - show output preview or running status
  const getSummaryLine = () => {
    if (latestProgress && !result) {
      const elapsed = latestProgress.data?.elapsedTimeSeconds
      const lines = latestProgress.data?.totalLines
      return `Running${elapsed ? ` ${elapsed}s` : ''}${lines ? `, ${lines} lines` : ''}`
    }
    if (errorText) {
      // Show first line of error
      const firstLine = errorText.split('\n')[0].trim()
      return firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine
    }
    if (outputText) {
      // Show first line of output
      const firstLine = outputText.split('\n')[0].trim()
      return firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine
    }
    return null
  }

  const summaryLine = getSummaryLine()

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: ● Bash command ▸/▾ */}
      <button
        onClick={() => hasOutput && setExpanded(!expanded)}
        className={`flex items-start gap-2 w-full text-left ${hasOutput ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
      >
        <MessageDot status={dotStatus} />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Bash
          </span>
          <span
            className="truncate"
            style={{ color: 'var(--claude-text-secondary)' }}
          >
            {commandText}
          </span>
          {hasOutput && (
            <span
              className="text-[11px] flex-shrink-0"
              style={{ color: 'var(--claude-text-tertiary)' }}
            >
              {expanded ? '▾' : '▸'}
            </span>
          )}
        </div>
      </button>

      {/* Summary line: └ output preview */}
      {summaryLine && (
        <div
          className="flex gap-2 ml-5"
          style={{ color: errorText ? 'var(--claude-status-alert)' : 'var(--claude-text-secondary)' }}
        >
          <span>└</span>
          <span className="truncate">{summaryLine}</span>
        </div>
      )}

      {/* Expanded output - smooth collapse */}
      <div className={`collapsible-grid ${expanded && hasOutput ? '' : 'collapsed'}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-2 ml-5 p-3 rounded-md overflow-y-auto whitespace-pre-wrap break-all"
            style={{
              backgroundColor: 'var(--claude-bg-code-block)',
              maxHeight: '60vh',
              color: errorText ? 'var(--claude-status-alert)' : 'var(--claude-text-secondary)',
            }}
          >
            {errorText || outputText}
          </div>
        </div>
      </div>
    </div>
  )
}
