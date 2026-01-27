import { useState, useEffect } from 'react'
import { MessageDot } from '../message-dot'
import { parseMarkdown } from '~/lib/shiki'
import type { ToolCall, WebFetchToolParams, WebFetchToolResult } from '~/types/claude'

interface WebFetchToolViewProps {
  toolCall: ToolCall
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

      {/* Expanded markdown content (like thinking block) */}
      {isExpanded && content && (
        <div
          className="mt-2 ml-5 p-4 rounded-md prose-claude overflow-y-auto"
          style={{
            backgroundColor: 'var(--claude-bg-code-block)',
            maxHeight: '60vh',
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
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
