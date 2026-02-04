import { useState } from 'react'
import { MessageDot } from '../message-dot'
import type { ToolCall, WebSearchToolParams, WebSearchToolResult, WebSearchLinkResult, WebSearchResultsContainer } from '~/types/claude'

interface WebSearchToolViewProps {
  toolCall: ToolCall
}

/**
 * Extract links from WebSearch result.
 * Handles both formats:
 * - New format: results[0] is { tool_use_id, content: [{title, url}, ...] }
 * - Legacy format: results might be an array of {title, url} directly
 */
function extractLinks(result: WebSearchToolResult | undefined): WebSearchLinkResult[] {
  if (!result?.results || !Array.isArray(result.results)) {
    return []
  }

  // Check if first element has the container format (new format)
  const firstElement = result.results[0]
  if (firstElement && typeof firstElement === 'object' && 'content' in firstElement) {
    const container = firstElement as WebSearchResultsContainer
    return container.content || []
  }

  // Legacy format: direct array of link results
  if (firstElement && typeof firstElement === 'object' && 'title' in firstElement && 'url' in firstElement) {
    return result.results as WebSearchLinkResult[]
  }

  return []
}

/**
 * Format duration in seconds to human-readable string
 */
function formatDuration(seconds: number): string {
  if (seconds < 1) {
    return `${Math.round(seconds * 1000)}ms`
  }
  return `${seconds.toFixed(1)}s`
}

export function WebSearchToolView({ toolCall }: WebSearchToolViewProps) {
  const params = toolCall.parameters as WebSearchToolParams
  const result = toolCall.result as WebSearchToolResult | undefined
  const [isExpanded, setIsExpanded] = useState(false)

  const links = extractLinks(result)
  const linkCount = links.length
  const duration = result?.durationSeconds

  const hasContent = linkCount > 0

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Clickable header: Status-colored bullet + "WebSearch" + query + chevron */}
      <button
        type="button"
        onClick={() => hasContent && setIsExpanded(!isExpanded)}
        className={`flex items-start gap-2 w-full text-left ${hasContent ? 'hover:opacity-80 transition-opacity cursor-pointer' : ''}`}
      >
        <MessageDot status={toolCall.status} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            WebSearch
          </span>
          <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.query}
          </span>
          {/* Chevron indicator for expandable content */}
          {hasContent && (
            <span
              className="ml-2 select-none text-[11px]"
              style={{ color: 'var(--claude-text-tertiary)' }}
            >
              {isExpanded ? '▾' : '▸'}
            </span>
          )}
        </div>
      </button>

      {/* Summary line: Found X results (duration) */}
      {linkCount > 0 ? (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>
            Found {linkCount} result{linkCount !== 1 ? 's' : ''}
            {duration !== undefined && (
              <span style={{ color: 'var(--claude-text-tertiary)' }}> ({formatDuration(duration)})</span>
            )}
          </span>
        </div>
      ) : toolCall.status === 'completed' ? (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-tertiary)' }}>
          <span className="select-none">└</span>
          <span>No results found</span>
        </div>
      ) : null}

      {/* Expanded content: List of links - smooth collapse */}
      <div className={`collapsible-grid ${isExpanded && hasContent ? '' : 'collapsed'}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-2 ml-5 p-3 rounded-md overflow-y-auto space-y-2"
            style={{
              backgroundColor: 'var(--claude-bg-code-block)',
              maxHeight: '40vh',
            }}
          >
            {links.map((link, index) => (
              <div key={index} className="flex flex-col">
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline break-words"
                  style={{ color: 'var(--claude-text-link, #2563eb)' }}
                >
                  {link.title || link.url}
                </a>
                {link.title && (
                  <span
                    className="text-[11px] break-all"
                    style={{ color: 'var(--claude-text-tertiary)' }}
                  >
                    {link.url}
                  </span>
                )}
              </div>
            ))}
          </div>
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
