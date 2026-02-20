import { useState, useMemo, useEffect } from 'react'
import { MessageDot, toolStatusToDotType } from '../message-dot'
import { SessionMessages } from '../session-messages'
import type { AgentProgressMessage } from '../session-messages'
import type { ToolCall, TaskToolParams } from '~/types/claude'
import type { SessionMessage, TaskToolResult } from '~/lib/session-message-utils'
import { parseMarkdown } from '~/lib/markdown'

interface TaskToolViewProps {
  toolCall: ToolCall
  /** Map from tool_use ID to agent progress messages */
  agentProgressMap?: Map<string, AgentProgressMessage[]>
  /** Map from parentToolUseID to subagent messages */
  subagentMessagesMap?: Map<string, SessionMessage[]>
  /** Nesting depth for recursive rendering (0 = top-level) */
  depth?: number
}

export function TaskToolView({ toolCall, agentProgressMap, subagentMessagesMap, depth = 0 }: TaskToolViewProps) {
  const [expanded, setExpanded] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [resultExpanded, setResultExpanded] = useState(false)
  const [convExpanded, setConvExpanded] = useState(false)
  const [resultHtml, setResultHtml] = useState('')

  const params = toolCall.parameters as TaskToolParams

  // Extract task metadata from tool_use_result (available for background/local agent results)
  // Contains description, prompt, output, status, etc. — persisted even when agentProgress is empty
  const taskMeta = useMemo((): TaskToolResult['task'] | undefined => {
    if (toolCall.result === undefined || toolCall.result === null || typeof toolCall.result === 'string') {
      return undefined
    }
    return (toolCall.result as TaskToolResult).task
  }, [toolCall.result])

  // Extract result content - Task tool results come in several formats:
  // 1. String → render as markdown directly
  // 2. Object with content[] array → extract first text block as markdown
  // 3. Object with task.output/task.result → background/local agent result, render output as markdown
  // 4. Fallback → render as JSON
  const { resultText, resultIsMarkdown } = useMemo(() => {
    if (toolCall.result === undefined || toolCall.result === null) {
      return { resultText: undefined, resultIsMarkdown: false }
    }

    // Handle string result directly
    if (typeof toolCall.result === 'string') {
      return { resultText: toolCall.result, resultIsMarkdown: true }
    }

    const resultObj = toolCall.result as Record<string, unknown>

    // Check for structured content array (Task tool result format)
    const content = resultObj.content as Array<{ type: string; text?: string }> | undefined

    if (Array.isArray(content) && content.length > 0) {
      const firstBlock = content[0]
      if (firstBlock.type === 'text' && typeof firstBlock.text === 'string') {
        return { resultText: firstBlock.text, resultIsMarkdown: true }
      }
    }

    // Check for background/local agent result: { task: { output, result } }
    if (taskMeta) {
      const taskOutput = taskMeta.output || taskMeta.result
      if (typeof taskOutput === 'string') {
        return { resultText: taskOutput, resultIsMarkdown: true }
      }
    }

    // Fallback: render as JSON
    return { resultText: JSON.stringify(toolCall.result, null, 2), resultIsMarkdown: false }
  }, [toolCall.result, taskMeta])

  const result = resultText

  // Get subagent messages for this tool_use ID (primary source - persisted messages)
  const subagentMessages = useMemo(() => {
    if (!subagentMessagesMap) return []
    return subagentMessagesMap.get(toolCall.id) || []
  }, [subagentMessagesMap, toolCall.id])

  // Get agent progress messages for this tool_use ID (fallback for live streaming)
  const agentProgress = useMemo(() => {
    if (!agentProgressMap) return []
    return agentProgressMap.get(toolCall.id) || []
  }, [agentProgressMap, toolCall.id])

  // Get messages from agent progress for live streaming
  // Strategy:
  // 1. First try normalizedMessages from the latest progress (contains full conversation)
  // 2. If empty, accumulate individual messages from data.message across all progress events
  const progressMessages = useMemo(() => {
    if (agentProgress.length === 0) return []

    // Try normalizedMessages first (full conversation snapshot)
    const latest = agentProgress[agentProgress.length - 1]
    const normalized = latest.data?.normalizedMessages
    if (normalized && normalized.length > 0) {
      return normalized
    }

    // Fallback: accumulate from data.message across all progress events
    // Each progress event may contain a single message in data.message
    const accumulated: SessionMessage[] = []
    const seenUuids = new Set<string>()

    for (const progress of agentProgress) {
      const msg = progress.data?.message as SessionMessage | undefined
      if (msg && msg.uuid && !seenUuids.has(msg.uuid)) {
        seenUuids.add(msg.uuid)
        accumulated.push(msg)
      }
    }

    return accumulated
  }, [agentProgress])

  // Use subagent messages if available (persisted), otherwise fall back to agent progress (live streaming)
  // See docs/claude-code/data-models.md "Subagent Message Hierarchy" section for details
  const nestedMessages = subagentMessages.length > 0 ? subagentMessages : progressMessages

  // Extract the prompt sent to the subagent
  // Sources (in priority order):
  // 1. agent_progress messages (live streaming — first progress event has the prompt)
  // 2. tool_use_result.task.prompt (persisted in completed result metadata)
  // 3. tool_use input params.prompt (always available from the tool_use block)
  const subagentPrompt = useMemo(() => {
    if (agentProgress.length > 0) {
      const progressPrompt = agentProgress[0]?.data?.prompt
      if (progressPrompt) return progressPrompt
    }
    return taskMeta?.prompt || params.prompt || null
  }, [agentProgress, taskMeta, params.prompt])

  // Determine if header should be expandable
  const hasExpandableContent = result || subagentPrompt || nestedMessages.length > 0

  // Parse result as markdown or highlight as JSON (only when result section is expanded)
  useEffect(() => {
    if (!expanded || !resultExpanded || !result) {
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
      import('~/lib/markdown').then(({ highlightCode }) => {
        highlightCode(result, 'json').then((highlighted) => {
          if (!cancelled) setResultHtml(highlighted)
        })
      })
    }

    return () => {
      cancelled = true
    }
  }, [expanded, resultExpanded, result, resultIsMarkdown])

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "Task" + description (clickable to expand) */}
      {hasExpandableContent ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-start gap-2 w-full text-left hover:opacity-80 transition-opacity cursor-pointer"
        >
          <MessageDot type={toolStatusToDotType(toolCall.status)} />
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
          <MessageDot type={toolStatusToDotType(toolCall.status)} />
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

      {/* Expanded content: three peer collapsible sections */}
      <div className={`collapsible-grid ${expanded ? '' : 'collapsed'}`}>
        <div className="collapsible-grid-content">
          {/* 1. Prompt */}
          {subagentPrompt && (
            <div className="mt-2 ml-5">
              <button
                type="button"
                onClick={() => setPromptExpanded(!promptExpanded)}
                className="flex items-center gap-2 text-left hover:opacity-80 transition-opacity cursor-pointer"
                style={{ color: 'var(--claude-text-secondary)' }}
              >
                <span
                  className="select-none text-[11px]"
                  style={{ color: 'var(--claude-text-tertiary)' }}
                >
                  {promptExpanded ? '▾' : '▸'}
                </span>
                <span className="text-[12px]">Prompt</span>
              </button>

              <div className={`collapsible-grid ${promptExpanded ? '' : 'collapsed'}`}>
                <div className="collapsible-grid-content">
                  <div
                    className="mt-2 p-3 rounded-md text-[12px] whitespace-pre-wrap overflow-y-auto"
                    style={{
                      backgroundColor: 'var(--claude-bg-code-block)',
                      color: 'var(--claude-text-secondary)',
                      maxHeight: '60vh',
                    }}
                  >
                    {subagentPrompt}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 2. Output */}
          {result && (
            <div className="mt-2 ml-5">
              <button
                type="button"
                onClick={() => setResultExpanded(!resultExpanded)}
                className="flex items-center gap-2 text-left hover:opacity-80 transition-opacity cursor-pointer"
                style={{ color: 'var(--claude-text-secondary)' }}
              >
                <span
                  className="select-none text-[11px]"
                  style={{ color: 'var(--claude-text-tertiary)' }}
                >
                  {resultExpanded ? '▾' : '▸'}
                </span>
                <span className="text-[12px]">Output</span>
              </button>

              <div className={`collapsible-grid ${resultExpanded ? '' : 'collapsed'}`}>
                <div className="collapsible-grid-content">
                  <div
                    className={`mt-2 p-4 rounded-md overflow-y-auto ${resultIsMarkdown ? 'prose-claude' : '[&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:!bg-transparent [&_code]:!bg-transparent text-[12px]'}`}
                    style={{
                      backgroundColor: 'var(--claude-bg-code-block)',
                      maxHeight: '60vh',
                    }}
                    dangerouslySetInnerHTML={{ __html: resultHtml }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* 3. Conversation */}
          {nestedMessages.length > 0 && (
            <div className="mt-2 ml-5">
              <button
                type="button"
                onClick={() => setConvExpanded(!convExpanded)}
                className="flex items-center gap-2 text-left hover:opacity-80 transition-opacity cursor-pointer"
                style={{ color: 'var(--claude-text-secondary)' }}
              >
                <span
                  className="select-none text-[11px]"
                  style={{ color: 'var(--claude-text-tertiary)' }}
                >
                  {convExpanded ? '▾' : '▸'}
                </span>
                <span className="text-[12px]">
                  Conversation ({nestedMessages.length} messages)
                </span>
              </button>

              <div className={`collapsible-grid ${convExpanded ? '' : 'collapsed'}`}>
                <div className="collapsible-grid-content">
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
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

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
