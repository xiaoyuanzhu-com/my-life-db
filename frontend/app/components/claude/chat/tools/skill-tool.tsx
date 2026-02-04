import { useState, useEffect } from 'react'
import { MessageDot } from '../message-dot'
import { parseMarkdown } from '~/lib/shiki'
import type { ToolCall } from '~/types/claude'

interface SkillToolParams {
  skill?: string
  args?: string
}

interface SkillToolViewProps {
  toolCall: ToolCall
  /** Map from tool_use ID to skill content (from isMeta messages) */
  skillContentMap?: Map<string, string>
}

export function SkillToolView({ toolCall, skillContentMap }: SkillToolViewProps) {
  const params = toolCall.parameters as SkillToolParams
  const skillName = params.skill || 'unknown'
  const [isExpanded, setIsExpanded] = useState(false)
  const [html, setHtml] = useState('')

  // Get skill content from the map using tool_use ID
  const skillContent = skillContentMap?.get(toolCall.id) || ''
  const hasContent = skillContent.length > 0

  // Parse markdown content only when expanded
  useEffect(() => {
    if (!isExpanded || !skillContent) {
      setHtml('')
      return
    }

    let cancelled = false
    parseMarkdown(skillContent).then((parsed) => {
      if (!cancelled) setHtml(parsed)
    })

    return () => {
      cancelled = true
    }
  }, [isExpanded, skillContent])

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Clickable header: Status-colored bullet + "Skill" + skill name + chevron */}
      <button
        type="button"
        onClick={() => hasContent && setIsExpanded(!isExpanded)}
        className={`flex items-start gap-2 w-full text-left ${hasContent ? 'hover:opacity-80 transition-opacity cursor-pointer' : ''}`}
      >
        <MessageDot status={toolCall.status} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Skill
          </span>
          <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
            {skillName}
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

      {/* Summary line: Loaded skill */}
      <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
        <span className="select-none">└</span>
        <span>Loaded skill</span>
      </div>

      {/* Expanded markdown content (like thinking block) - smooth collapse */}
      <div className={`collapsible-grid ${isExpanded && hasContent ? '' : 'collapsed'}`}>
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
