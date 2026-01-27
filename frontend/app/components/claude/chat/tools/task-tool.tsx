import { useState, useMemo, useEffect } from 'react'
import { MessageDot } from '../message-dot'
import { SessionMessages } from '../session-messages'
import type { AgentProgressMessage } from '../session-messages'
import type { ToolCall, TaskToolParams } from '~/types/claude'
import { parseMarkdown } from '~/lib/shiki'

interface TaskToolViewProps {
  toolCall: ToolCall
  /** Map from tool_use ID to agent progress messages */
  agentProgressMap?: Map<string, AgentProgressMessage[]>
  /** Nesting depth for recursive rendering (0 = top-level) */
  depth?: number
}

export function TaskToolView({ toolCall, agentProgressMap, depth = 0 }: TaskToolViewProps) {
  const [expanded, setExpanded] = useState(false)
  const [agentExpanded, setAgentExpanded] = useState(false)
  const [resultHtml, setResultHtml] = useState('')

  const params = toolCall.parameters as TaskToolParams

  // Extract result content - Task tool results have structured content blocks
  // We look for the first text block in toolUseResult.content and render as markdown
  // Otherwise fall back to JSON display
  const { resultText, resultIsMarkdown } = useMemo(() => {
    if (toolCall.result === undefined || toolCall.result === null) {
      return { resultText: undefined, resultIsMarkdown: false }
    }

    // Handle string result directly
    if (typeof toolCall.result === 'string') {
      return { resultText: toolCall.result, resultIsMarkdown: true }
    }

    // Check for structured content array (Task tool result format)
    const resultObj = toolCall.result as Record<string, unknown>
    const content = resultObj.content as Array<{ type: string; text?: string }> | undefined

    if (Array.isArray(content) && content.length > 0) {
      const firstBlock = content[0]
      if (firstBlock.type === 'text' && typeof firstBlock.text === 'string') {
        return { resultText: firstBlock.text, resultIsMarkdown: true }
      }
    }

    // Fallback: render as JSON
    return { resultText: JSON.stringify(toolCall.result, null, 2), resultIsMarkdown: false }
  }, [toolCall.result])

  const result = resultText

  // Get agent progress messages for this tool_use ID
  const agentProgress = useMemo(() => {
    if (!agentProgressMap) return []
    return agentProgressMap.get(toolCall.id) || []
  }, [agentProgressMap, toolCall.id])

  // Get the latest normalized messages from agent progress
  // Each progress message contains the full conversation so far, so we take the last one
  const nestedMessages = useMemo(() => {
    if (agentProgress.length === 0) return []
    const latest = agentProgress[agentProgress.length - 1]
    return latest.data?.normalizedMessages || []
  }, [agentProgress])

  const hasNestedSession = nestedMessages.length > 0

  // Determine if header should be expandable
  const hasExpandableContent = result || hasNestedSession

  // Parse result as markdown or highlight as JSON (only when expanded)
  useEffect(() => {
    if (!expanded || !result) {
      setResultHtml('')
      return
    }

    let cancelled = false

    if (resultIsMarkdown) {
      parseMarkdown(result).then((html) => {
        if (!cancelled) setResultHtml(html)
      })
    } else {
      // JSON - use Shiki highlighting
      import('~/lib/shiki').then(({ getHighlighter }) => {
        getHighlighter().then((hl) => {
          if (cancelled) return
          try {
            const highlighted = hl.codeToHtml(result, {
              lang: 'json',
              themes: { light: 'github-light', dark: 'github-dark' },
              defaultColor: false,
            })
            setResultHtml(highlighted)
          } catch {
            setResultHtml(`<pre><code>${result}</code></pre>`)
          }
        })
      })
    }

    return () => {
      cancelled = true
    }
  }, [expanded, result, resultIsMarkdown])

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "Task" + description (clickable to expand) */}
      {hasExpandableContent ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-start gap-2 w-full text-left hover:opacity-80 transition-opacity cursor-pointer"
        >
          <MessageDot status={toolCall.status} />
          <div className="flex-1 min-w-0">
            <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
              Task
            </span>
            <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
              {params.description} ({params.subagent_type})
              {params.model && <span className="opacity-70 ml-1">[{params.model}]</span>}
              {params.run_in_background && <span className="opacity-70 ml-1">[background]</span>}
            </span>
            <span
              className="ml-2 select-none text-[11px]"
              style={{ color: 'var(--claude-text-tertiary)' }}
            >
              {expanded ? '▾' : '▸'}
            </span>
          </div>
        </button>
      ) : (
        <div className="flex items-start gap-2">
          <MessageDot status={toolCall.status} />
          <div className="flex-1 min-w-0">
            <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
              Task
            </span>
            <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
              {params.description} ({params.subagent_type})
              {params.model && <span className="opacity-70 ml-1">[{params.model}]</span>}
              {params.run_in_background && <span className="opacity-70 ml-1">[background]</span>}
            </span>
          </div>
        </div>
      )}

      {/* Status indicator when running */}
      {toolCall.status === 'running' && !result && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>Agent is working...</span>
        </div>
      )}

      {/* Expanded content: result + sub-agent session */}
      {expanded && (
        <>
          {/* Result content (rendered as markdown or JSON in 60vh scrolling div) */}
          {result && (
            <div
              className={`mt-2 ml-5 p-4 rounded-md overflow-y-auto ${resultIsMarkdown ? 'prose-claude' : '[&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:!bg-transparent [&_code]:!bg-transparent text-[12px]'}`}
              style={{
                backgroundColor: 'var(--claude-bg-code-block)',
                maxHeight: '60vh',
              }}
              dangerouslySetInnerHTML={{ __html: resultHtml }}
            />
          )}

          {/* Sub-agent session (separate expandable section) */}
          {hasNestedSession && (
            <div className="mt-2 ml-5">
              <button
                type="button"
                onClick={() => setAgentExpanded(!agentExpanded)}
                className="flex items-center gap-2 text-left hover:opacity-80 transition-opacity cursor-pointer"
                style={{ color: 'var(--claude-text-secondary)' }}
              >
                <span
                  className="select-none text-[11px]"
                  style={{ color: 'var(--claude-text-tertiary)' }}
                >
                  {agentExpanded ? '▾' : '▸'}
                </span>
                <span className="text-[12px]">
                  Sub-agent conversation ({nestedMessages.length} messages)
                </span>
              </button>

              {agentExpanded && (
                <div
                  className="mt-2 pl-3 overflow-y-auto"
                  style={{
                    borderLeft: '2px solid var(--claude-border-light)',
                    maxHeight: '60vh',
                  }}
                >
                  <SessionMessages
                    messages={nestedMessages}
                    depth={depth + 1}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Error (always visible) */}
      {toolCall.error && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-status-alert)' }}>
          <span className="select-none">└</span>
          <div className="flex-1 min-w-0">{toolCall.error}</div>
        </div>
      )}
    </div>
  )
}
