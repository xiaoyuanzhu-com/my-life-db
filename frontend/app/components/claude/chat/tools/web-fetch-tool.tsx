import { useState, useEffect } from 'react'
import { MessageDot } from '../message-dot'
import { parseMarkdown } from '~/lib/shiki'
import type { ToolCall, WebFetchToolParams, WebFetchToolResult } from '~/types/claude'

interface WebFetchToolViewProps {
  toolCall: ToolCall
}

/**
 * Format bytes to human-readable string (KB, MB, etc.)
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function WebFetchToolView({ toolCall }: WebFetchToolViewProps) {
  const params = toolCall.parameters as WebFetchToolParams
  const result = toolCall.result as WebFetchToolResult | string | undefined
  const [isExpanded, setIsExpanded] = useState(false)
  const [html, setHtml] = useState('')

  // Use result URL if available (for redirects), otherwise use params URL
  const effectiveUrl = (typeof result === 'object' && result?.url) ? result.url : params.url

  // Parse result - can be object (WebFetchToolResult) or string (error/simple case)
  const isObjectResult = typeof result === 'object' && result !== null
  const content = isObjectResult ? result.result : (typeof result === 'string' ? result : undefined)

  // Extract metadata for summary line
  const statusCode = isObjectResult ? result.code : undefined
  const statusText = isObjectResult ? result.codeText : undefined
  const bytes = isObjectResult ? result.bytes : undefined
  const durationMs = isObjectResult ? result.durationMs : undefined

  // Parse markdown content only when expanded
  useEffect(() => {
    if (!isExpanded || !content) {
      setHtml('')
      return
    }

    let cancelled = false
    parseMarkdown(content).then((parsed) => {
      if (!cancelled) setHtml(parsed)
    })

    return () => {
      cancelled = true
    }
  }, [isExpanded, content])

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Clickable header: Status-colored bullet + "WebFetch" + URL (truncated) + chevron */}
      <button
        type="button"
        onClick={() => content && setIsExpanded(!isExpanded)}
        className={`flex items-start gap-2 w-full text-left ${content ? 'hover:opacity-80 transition-opacity cursor-pointer' : ''}`}
      >
        <MessageDot status={toolCall.status} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            WebFetch
          </span>
          <span className="ml-2 break-all" style={{ color: 'var(--claude-text-secondary)' }}>
            {effectiveUrl}
          </span>
          {/* Chevron indicator for expandable content */}
          {content && (
            <span
              className="ml-2 select-none text-[11px]"
              style={{ color: 'var(--claude-text-tertiary)' }}
            >
              {isExpanded ? '▾' : '▸'}
            </span>
          )}
        </div>
      </button>

      {/* Summary line: HTTP status, size, duration */}
      {isObjectResult && statusCode !== undefined && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>
            {statusCode} {statusText}
            {(bytes !== undefined || durationMs !== undefined) && (
              <span style={{ color: 'var(--claude-text-tertiary)' }}>
                {' '}({[
                  bytes !== undefined && formatBytes(bytes),
                  durationMs !== undefined && formatDuration(durationMs),
                ].filter(Boolean).join(', ')})
              </span>
            )}
          </span>
        </div>
      )}

      {/* Expanded markdown content (like thinking block) - smooth collapse */}
      <div className={`collapsible-grid ${isExpanded && content ? '' : 'collapsed'}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-2 ml-5 p-4 rounded-md prose-claude overflow-y-auto"
            style={{
              backgroundColor: 'var(--claude-bg-code-block)',
              maxHeight: '60vh',
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>

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
