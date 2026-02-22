import { ToolBlock } from './tool-block'
import { MessageDot } from './message-dot'
import { splitMessageContent } from './file-ref'
import { SystemInitBlock } from './system-init-block'
import type { ToolCall, SystemInitData, ToolStatus } from '~/types/claude'
import {
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
  isToolResultError,
  isBashToolResult,
  isCompactBoundaryMessage,
  isMicrocompactBoundaryMessage,
  isCompactSummaryMessage,
  isStatusMessage,
  isSummaryMessage,
  isTurnDurationMessage,
  isHookStartedMessage,
  isTaskNotificationMessage,
  type SessionMessage,
  type ExtractedToolResult,
  type SummaryMessage,
} from '~/lib/session-message-utils'
import type { AgentProgressMessage, BashProgressMessage, HookProgressMessage, HookResponseMessage, ToolUseInfo } from './session-messages'
import { parseMarkdown, parseMarkdownSync, onMermaidThemeChange, highlightCode } from '~/lib/markdown'
import { PreviewFullscreen, wrapSvgInHtml } from './preview-fullscreen'
import { useEffect, useState, useMemo, memo, useRef } from 'react'

// Format duration in milliseconds to human-readable string (e.g., "2m 54s")
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (remainingSeconds === 0) {
    return `${minutes}m`
  }
  return `${minutes}m ${remainingSeconds}s`
}

interface MessageBlockProps {
  message: SessionMessage
  toolResultMap: Map<string, ExtractedToolResult>
  /** Map from tool_use ID to agent progress messages (for Task tools) */
  agentProgressMap?: Map<string, AgentProgressMessage[]>
  /** Map from tool_use ID to bash progress messages (for Bash tools) */
  bashProgressMap?: Map<string, BashProgressMessage[]>
  /** Map from tool_use ID to hook progress messages (for tools with post-hooks) */
  hookProgressMap?: Map<string, HookProgressMessage[]>
  /** Map from hook_id to hook_response messages (for pairing hook_started with hook_response) */
  hookResponseMap?: Map<string, HookResponseMessage>
  /** Map from tool_use ID to tool info (for microcompact_boundary) */
  toolUseMap?: Map<string, ToolUseInfo>
  /** Map from tool_use ID to skill content (for Skill tools) */
  skillContentMap?: Map<string, string>
  /** Map from parentToolUseID to subagent messages (for Task tools) */
  subagentMessagesMap?: Map<string, SessionMessage[]>
  /** Nesting depth for recursive rendering (0 = top-level) */
  depth?: number
}

export function MessageBlock({ message, toolResultMap, agentProgressMap, bashProgressMap, hookProgressMap, hookResponseMap, toolUseMap, skillContentMap, subagentMessagesMap, depth = 0 }: MessageBlockProps) {
  const isUser = message.type === 'user'
  const isAssistant = message.type === 'assistant'
  const isSystem = message.type === 'system'

  // Extract content from message
  const content = message.message?.content

  // For user messages: content can be a string OR an array of content blocks
  const userTextContent = useMemo(() => {
    if (!isUser) return null
    if (typeof content === 'string') return content
    // Handle array of content blocks (e.g., when IDE injects context)
    if (Array.isArray(content)) {
      const texts = content.filter(isTextBlock).map((block) => block.text)
      return texts.join('\n') || null
    }
    return null
  }, [isUser, content])

  // For assistant messages: extract text, thinking, and tool_use blocks from array
  const { textContent, thinkingBlocks, toolUseBlocks } = useMemo(() => {
    if (!isAssistant || !Array.isArray(content)) {
      return { textContent: '', thinkingBlocks: [], toolUseBlocks: [] }
    }

    const texts = content.filter(isTextBlock).map((block) => block.text)
    const thinking = content.filter(isThinkingBlock)
    const toolUses = content.filter(isToolUseBlock)

    return {
      textContent: texts.join('\n'),
      thinkingBlocks: thinking,
      toolUseBlocks: toolUses,
    }
  }, [isAssistant, content])

  // Convert tool_use blocks to ToolCall format with results from map
  const toolCalls = useMemo((): ToolCall[] => {
    return toolUseBlocks.map((block) => {
      const toolResult = toolResultMap.get(block.id)

      // Determine result and error based on toolUseResult format
      let result: unknown = undefined
      let error: string | undefined = undefined
      let status: ToolStatus = toolResult ? 'completed' : 'pending'

      if (toolResult) {
        if (isToolResultError(toolResult.toolUseResult)) {
          // Error case: toolUseResult is a string
          error = toolResult.toolUseResult
          status = 'failed'
        } else if (isBashToolResult(toolResult.toolUseResult)) {
          // Bash success: extract stdout/stderr
          const bashResult = toolResult.toolUseResult
          result = {
            output: bashResult.stdout || '',
            exitCode: toolResult.isError ? 1 : 0,
          }
          if (toolResult.isError) {
            status = 'failed'
          }
        } else {
          // Other tool results: pass through the toolUseResult
          result = toolResult.toolUseResult || toolResult.content
        }
      }

      return {
        id: block.id,
        name: block.name as ToolCall['name'],
        parameters: block.input,
        status,
        result,
        error,
      }
    })
  }, [toolUseBlocks, toolResultMap])

  // Parse system init data
  const systemInitData = useMemo((): SystemInitData | null => {
    if (!isSystem) return null
    // System init messages have the data spread on the message itself
    if ((message as unknown as { subtype?: string }).subtype === 'init') {
      return message as unknown as SystemInitData
    }
    return null
  }, [isSystem, message])

  // Check for compact boundary, microcompact boundary, compact summary, turn duration, hook started, and summary messages
  const isCompactBoundary = isCompactBoundaryMessage(message)
  const isMicrocompactBoundary = isMicrocompactBoundaryMessage(message)
  const isCompactSummary = isCompactSummaryMessage(message)
  const isTurnDuration = isTurnDurationMessage(message)
  const isHookStarted = isHookStartedMessage(message)
  const isTaskNotification = isTaskNotificationMessage(message)
  const isSummary = isSummaryMessage(message)

  // Check for compacting status message (ephemeral, shown during compaction)
  const isCompactingStatus = isStatusMessage(message) &&
    ((message as unknown as Record<string, unknown>).status === 'compacting' ||
     (message as unknown as Record<string, unknown>).content === 'compacting')

  // Determine what to render
  const hasUserContent = isUser && userTextContent && !isCompactSummary
  const hasAssistantText = isAssistant && textContent
  const hasThinking = thinkingBlocks.length > 0
  const hasToolCalls = toolCalls.length > 0
  const hasSystemInit = systemInitData !== null
  const hasUnknownSystem = isSystem && !hasSystemInit && !isCompactBoundary && !isMicrocompactBoundary && !isTurnDuration && !isHookStarted && !isTaskNotification && !isCompactingStatus

  // Unknown message type - render as raw JSON
  // Note: agent_progress messages are filtered out in SessionMessages and rendered inside Task tools
  // Note: summary messages have dedicated rendering
  const isUnknownType = !isUser && !isAssistant && !isSystem && !isSummary
  const hasUnknownMessage = isUnknownType || hasUnknownSystem

  // Skip rendering if there's nothing to show
  if (!hasUserContent && !hasAssistantText && !hasThinking && !hasToolCalls && !hasSystemInit && !isCompactBoundary && !isMicrocompactBoundary && !isCompactSummary && !isCompactingStatus && !isTurnDuration && !isHookStarted && !isTaskNotification && !isSummary && !hasUnknownMessage) {
    return null
  }

  return (
    <div className="mb-4">
      {/* User messages: gray background pill, right-aligned */}
      {hasUserContent && <UserMessageBlock content={userTextContent!} />}

      {/* System init messages: special formatted display */}
      {hasSystemInit && (
        <div className="flex items-start gap-2">
          <MessageDot type="system" />
          <div className="flex-1 min-w-0">
            <SystemInitBlock data={systemInitData!} />
          </div>
        </div>
      )}

      {/* Compacting in progress: animated three-dot indicator */}
      {isCompactingStatus && (
        <div className="flex items-start gap-2">
          <MessageDot type="compacting" />
          <span className="font-mono text-[13px] leading-[1.5] font-semibold flex items-center gap-0">
            <span style={{ color: 'var(--claude-text-primary)' }}>Compacting</span>
            <span className="inline-flex w-[1.5em]">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="inline-block"
                  style={{
                    color: 'var(--claude-text-primary)',
                    animation: `compacting-dot-${i} 1.44s linear infinite`,
                  }}
                >
                  .
                </span>
              ))}
            </span>
            <style>{`
              @keyframes compacting-dot-0 {
                0%, 100% { opacity: 0; }
                1%, 99% { opacity: 1; }
              }
              @keyframes compacting-dot-1 {
                0%, 33% { opacity: 0; }
                34%, 99% { opacity: 1; }
                100% { opacity: 0; }
              }
              @keyframes compacting-dot-2 {
                0%, 66% { opacity: 0; }
                67%, 99% { opacity: 1; }
                100% { opacity: 0; }
              }
            `}</style>
          </span>
        </div>
      )}

      {/* Compact boundary: system message style (matches Bash tool title) */}
      {isCompactBoundary && (
        <div className="flex items-start gap-2">
          <MessageDot type="system" />
          <span
            className="font-mono text-[13px] leading-[1.5] font-semibold"
            style={{ color: 'var(--claude-text-primary)' }}
          >
            Session compacted
          </span>
        </div>
      )}

      {/* Microcompact boundary: collapsible showing which tools were compacted */}
      {isMicrocompactBoundary && (
        <MicrocompactBlock message={message} toolUseMap={toolUseMap} />
      )}

      {/* Turn duration: system telemetry showing how long a turn took */}
      {isTurnDuration && (
        <div className="flex items-start gap-2">
          <MessageDot type="system" />
          <span
            className="font-mono text-[13px] leading-[1.5]"
            style={{ color: 'var(--claude-text-secondary)' }}
          >
            Turn completed in {formatDuration(message.durationMs ?? 0)}
          </span>
        </div>
      )}

      {/* Hook started: paired with hook_response via hookResponseMap */}
      {isHookStarted && (
        <HookBlock
          hookStarted={message}
          hookResponse={message.hook_id ? hookResponseMap?.get(message.hook_id) : undefined}
        />
      )}

      {/* Task notification: background task completed/failed */}
      {isTaskNotification && (
        <TaskNotificationBlock message={message} />
      )}

      {/* Summary message: automatic conversation summarization */}
      {isSummary && (
        <div className="flex items-start gap-2">
          <MessageDot type="system" />
          <div className="flex-1 min-w-0">
            <span
              className="font-mono text-[13px] leading-[1.5] font-semibold"
              style={{ color: 'var(--claude-text-primary)' }}
            >
              Session summary
            </span>
            <div
              className="mt-1 flex gap-2 font-mono text-[13px] leading-[1.5]"
              style={{ color: 'var(--claude-text-secondary)' }}
            >
              <span className="select-none">└</span>
              <span>{(message as SummaryMessage).summary}</span>
            </div>
          </div>
        </div>
      )}

      {/* Compact summary: collapsible markdown content */}
      {isCompactSummary && userTextContent && (
        <CompactSummaryBlock content={userTextContent} />
      )}

      {/* Unknown message types: render as syntax-highlighted JSON with show more/less */}
      {hasUnknownMessage && (
        <UnknownMessageBlock message={message} />
      )}

      {/* Assistant messages: bullet + markdown content */}
      {hasAssistantText && (
        <div className="flex gap-2">
          <MessageDot type="assistant" />
          <div className="flex-1 min-w-0">
            <MessageContent content={textContent} />
          </div>
        </div>
      )}

      {/* Thinking blocks: rendered separately with mono styling */}
      {hasThinking && (
        <div className={textContent ? 'mt-2' : ''}>
          <ThinkingBlocks thinking={thinkingBlocks} />
        </div>
      )}

      {/* Tool calls */}
      {hasToolCalls && (
        <div className="mt-3 space-y-2">
          <ToolCallGroups toolCalls={toolCalls} agentProgressMap={agentProgressMap} bashProgressMap={bashProgressMap} hookProgressMap={hookProgressMap} skillContentMap={skillContentMap} subagentMessagesMap={subagentMessagesMap} depth={depth} />
        </div>
      )}
    </div>
  )
}


// Group consecutive tool calls of the same type
function ToolCallGroups({
  toolCalls,
  agentProgressMap,
  bashProgressMap,
  hookProgressMap,
  skillContentMap,
  subagentMessagesMap,
  depth,
}: {
  toolCalls: ToolCall[]
  agentProgressMap?: Map<string, AgentProgressMessage[]>
  bashProgressMap?: Map<string, BashProgressMessage[]>
  hookProgressMap?: Map<string, HookProgressMessage[]>
  skillContentMap?: Map<string, string>
  subagentMessagesMap?: Map<string, SessionMessage[]>
  depth: number
}) {
  // Group consecutive tool calls by name
  const groups: ToolCall[][] = []
  let currentGroup: ToolCall[] = []
  let currentName: string | null = null

  toolCalls.forEach((toolCall) => {
    if (toolCall.name === currentName) {
      // Same tool type - add to current group
      currentGroup.push(toolCall)
    } else {
      // Different tool type - start new group
      if (currentGroup.length > 0) {
        groups.push(currentGroup)
      }
      currentGroup = [toolCall]
      currentName = toolCall.name
    }
  })

  // Push final group
  if (currentGroup.length > 0) {
    groups.push(currentGroup)
  }

  return (
    <>
      {groups.map((group, groupIndex) => {
        // Single tool call - render directly
        if (group.length === 1) {
          return (
            <ToolBlock
              key={group[0].id}
              toolCall={group[0]}
              agentProgressMap={agentProgressMap}
              bashProgressMap={bashProgressMap}
              hookProgressMap={hookProgressMap}
              skillContentMap={skillContentMap}
              subagentMessagesMap={subagentMessagesMap}
              depth={depth}
            />
          )
        }

        // Multiple tool calls of same type - render as collapsible group
        return (
          <ToolCallGroup
            key={`group-${groupIndex}`}
            toolCalls={group}
            agentProgressMap={agentProgressMap}
            bashProgressMap={bashProgressMap}
            hookProgressMap={hookProgressMap}
            skillContentMap={skillContentMap}
            subagentMessagesMap={subagentMessagesMap}
            depth={depth}
          />
        )
      })}
    </>
  )
}

// Collapsible group for multiple tool calls of the same type
function ToolCallGroup({
  toolCalls,
  agentProgressMap,
  bashProgressMap,
  hookProgressMap,
  skillContentMap,
  subagentMessagesMap,
  depth,
}: {
  toolCalls: ToolCall[]
  agentProgressMap?: Map<string, AgentProgressMessage[]>
  bashProgressMap?: Map<string, BashProgressMessage[]>
  hookProgressMap?: Map<string, HookProgressMessage[]>
  skillContentMap?: Map<string, string>
  subagentMessagesMap?: Map<string, SessionMessage[]>
  depth: number
}) {
  const [isExpanded, setIsExpanded] = useState(true)
  const toolName = toolCalls[0].name

  return (
    <div>
      {/* Group header - collapsible */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="font-mono text-[13px] leading-[1.5] flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity"
        style={{ color: 'var(--claude-text-secondary)' }}
      >
        <span className="select-none">{isExpanded ? '∨' : '>'}</span>
        <span>
          {toolName} {toolCalls.length} file{toolCalls.length !== 1 ? 's' : ''}
        </span>
      </button>

      {/* Individual tool calls - indented with smooth collapse */}
      <div className={`collapsible-grid ${isExpanded ? '' : 'collapsed'}`}>
        <div className="collapsible-grid-content">
          <div className="ml-6 mt-2 space-y-2">
            {toolCalls.map((toolCall) => (
              <ToolBlock
                key={toolCall.id}
                toolCall={toolCall}
                agentProgressMap={agentProgressMap}
                bashProgressMap={bashProgressMap}
                hookProgressMap={hookProgressMap}
                skillContentMap={skillContentMap}
                subagentMessagesMap={subagentMessagesMap}
                depth={depth}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// Markdown content renderer using marked + shiki
// Memoized to prevent re-renders on parent scroll
//
// SEAMLESS STREAMING TRANSITION:
// Uses parseMarkdownSync() for immediate initial render (no syntax highlighting),
// then upgrades to parseMarkdown() (with syntax highlighting) asynchronously.
// This ensures content is never blank during the streaming→final message transition.
const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  // Sync-parsed HTML — available immediately for zero-flash rendering.
  // This is the same parser used by StreamingResponse, ensuring visual consistency
  // during the streaming→final message transition.
  const syncHtml = useMemo(() => parseMarkdownSync(content), [content])

  // Async-parsed HTML — upgraded version with syntax highlighting, mermaid, etc.
  // Tracked alongside the content it was parsed from, so we can invalidate correctly.
  const [asyncState, setAsyncState] = useState<{ content: string; html: string } | null>(null)
  const [themeKey, setThemeKey] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const lastHtmlRef = useRef<string>('')

  // Fullscreen preview state
  const [fullscreenSrcdoc, setFullscreenSrcdoc] = useState<string | null>(null)

  // Use async HTML only if it matches current content, otherwise fall back to sync HTML
  const html = (asyncState && asyncState.content === content) ? asyncState.html : syncHtml

  // Re-render when theme changes (for mermaid diagrams)
  useEffect(() => {
    return onMermaidThemeChange(() => setThemeKey((k) => k + 1))
  }, [])

  // Upgrade to async-parsed HTML (with syntax highlighting, mermaid, etc.)
  useEffect(() => {
    let cancelled = false
    const contentForParse = content

    parseMarkdown(contentForParse).then((parsed) => {
      if (!cancelled) setAsyncState({ content: contentForParse, html: parsed })
    })

    return () => {
      cancelled = true
    }
  }, [content, themeKey])

  // Use a ref-based approach to avoid re-rendering iframes
  // Only update innerHTML when html actually changes
  useEffect(() => {
    if (containerRef.current && html !== lastHtmlRef.current) {
      lastHtmlRef.current = html
      containerRef.current.innerHTML = html
    }
  }, [html])

  // Event delegation: expand button click + double-click on preview containers
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    function extractFullscreenSrcdoc(previewEl: HTMLElement): string | null {
      if (previewEl.classList.contains('mermaid-diagram')) {
        // :scope > svg selects only direct-child SVGs, skipping the
        // expand-button icon SVG nested inside .preview-expand-btn.
        const svg = previewEl.querySelector(':scope > svg')
        if (!svg) return null
        return wrapSvgInHtml(svg.outerHTML)
      }
      if (previewEl.classList.contains('html-preview-container')) {
        const iframe = previewEl.querySelector('iframe')
        if (!iframe) return null
        return iframe.getAttribute('srcdoc') || null
      }
      return null
    }

    function handleClick(e: MouseEvent) {
      const btn = (e.target as HTMLElement).closest('.preview-expand-btn')
      if (!btn) return
      e.preventDefault()
      e.stopPropagation()
      const previewEl = btn.closest('.mermaid-diagram, .html-preview-container') as HTMLElement | null
      if (!previewEl) return
      const srcdoc = extractFullscreenSrcdoc(previewEl)
      if (srcdoc) setFullscreenSrcdoc(srcdoc)
    }

    function handleDblClick(e: MouseEvent) {
      const previewEl = (e.target as HTMLElement).closest('.mermaid-diagram, .html-preview-container') as HTMLElement | null
      if (!previewEl) return
      const srcdoc = extractFullscreenSrcdoc(previewEl)
      if (srcdoc) setFullscreenSrcdoc(srcdoc)
    }

    container.addEventListener('click', handleClick)
    container.addEventListener('dblclick', handleDblClick)
    return () => {
      container.removeEventListener('click', handleClick)
      container.removeEventListener('dblclick', handleDblClick)
    }
  }, [])

  return (
    <>
      <div
        ref={containerRef}
        className="prose-claude"
      />
      {fullscreenSrcdoc && (
        <PreviewFullscreen
          srcdoc={fullscreenSrcdoc}
          onClose={() => setFullscreenSrcdoc(null)}
        />
      )}
    </>
  )
})

// Thinking blocks renderer - collapsible extended thinking
interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

function ThinkingBlocks({ thinking }: { thinking: ThinkingBlock[] }) {
  if (thinking.length === 0) return null

  return (
    <div className="space-y-2">
      {thinking.map((block, index) => (
        <ThinkingBlockItem key={index} block={block} />
      ))}
    </div>
  )
}

function ThinkingBlockItem({ block }: { block: ThinkingBlock }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [html, setHtml] = useState('')

  useEffect(() => {
    if (!isExpanded || !block.thinking) return

    let cancelled = false
    parseMarkdown(block.thinking).then((parsed) => {
      if (!cancelled) setHtml(parsed)
    })

    return () => {
      cancelled = true
    }
  }, [isExpanded, block.thinking])

  return (
    <div className="my-2">
      {/* Collapsible header: dot + text + chevron */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="font-mono text-[13px] leading-[1.5] flex items-start gap-2 w-full text-left hover:opacity-80 transition-opacity cursor-pointer"
      >
        <MessageDot type="thinking" />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span
            className="italic"
            style={{ color: 'var(--claude-text-secondary)' }}
          >
            Thinking
          </span>
          <span
            className="select-none text-[11px]"
            style={{ color: 'var(--claude-text-tertiary)' }}
          >
            {isExpanded ? '▾' : '▸'}
          </span>
        </div>
      </button>

      {/* Expanded content - rendered as markdown with smooth collapse */}
      <div className={`collapsible-grid ${isExpanded ? '' : 'collapsed'}`}>
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
    </div>
  )
}

// Compact summary block - collapsible markdown content for session continuations
const MAX_SUMMARY_LINES = 10

function CompactSummaryBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const [themeKey, setThemeKey] = useState(0)

  // Re-render when theme changes (for mermaid diagrams)
  useEffect(() => {
    return onMermaidThemeChange(() => setThemeKey((k) => k + 1))
  }, [])

  const lines = content.split('\n')
  const isTruncated = lines.length > MAX_SUMMARY_LINES
  const displayContent = expanded ? content : lines.slice(0, MAX_SUMMARY_LINES).join('\n')

  const [html, setHtml] = useState('')
  useEffect(() => {
    let cancelled = false

    parseMarkdown(displayContent).then((parsed) => {
      if (!cancelled) setHtml(parsed)
    })

    return () => {
      cancelled = true
    }
  }, [displayContent, themeKey])

  return (
    <div className="flex items-start gap-2">
      <MessageDot type="system" />
      <div className="flex-1 min-w-0">
        <span
          className="font-mono text-[13px] leading-[1.5] font-semibold"
          style={{ color: 'var(--claude-text-primary)' }}
        >
          Session continued
        </span>

        <div
          className="mt-2 rounded-md overflow-hidden"
          style={{ border: '1px solid var(--claude-border-light)' }}
        >
          <div
            className={expanded && isTruncated ? 'overflow-y-auto' : ''}
            style={expanded && isTruncated ? { maxHeight: '60vh' } : {}}
          >
            <div
              className="p-4 prose-claude"
              style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>

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
    </div>
  )
}

// User message with file context extraction
const USER_MSG_MAX_LINES = 10
const USER_MSG_MAX_CHARS = 500

function UserMessageBlock({ content }: { content: string }) {
  const { context, message } = splitMessageContent(content)
  const [expanded, setExpanded] = useState(false)

  const lines = message?.split('\n') ?? []
  const exceedsLines = lines.length > USER_MSG_MAX_LINES
  const exceedsChars = (message?.length ?? 0) > USER_MSG_MAX_CHARS
  const isTruncated = exceedsLines || exceedsChars

  let displayMessage = message
  if (!expanded && isTruncated) {
    // Truncate by lines first, then by chars
    let truncated = lines.slice(0, USER_MSG_MAX_LINES).join('\n')
    if (truncated.length > USER_MSG_MAX_CHARS) {
      truncated = truncated.slice(0, USER_MSG_MAX_CHARS) + '...'
    }
    displayMessage = truncated
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {/* File context shown above the message bubble */}
      {context}

      {/* Message bubble - only show if there's actual message content */}
      {message && (
        <div
          className="relative inline-block max-w-[85%] rounded-xl overflow-hidden"
          style={{
            backgroundColor: 'var(--claude-bg-subtle)',
            color: 'var(--claude-text-primary)',
          }}
        >
          <div
            className={`px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap break-words ${expanded && isTruncated ? 'overflow-y-auto' : ''}`}
            style={expanded && isTruncated ? { maxHeight: '60vh' } : {}}
          >
            {displayMessage}
          </div>

          {/* Gradient fade + Show more button when truncated */}
          {isTruncated && !expanded && (
            <div
              className="absolute bottom-0 left-0 right-0 flex items-end justify-center pb-2 pt-8"
              style={{
                background: 'linear-gradient(to bottom, transparent, var(--claude-bg-subtle) 60%)',
              }}
            >
              <button
                onClick={() => setExpanded(true)}
                className="text-[12px] cursor-pointer hover:opacity-80 transition-opacity"
                style={{ color: 'var(--claude-text-secondary)' }}
              >
                Show more
              </button>
            </div>
          )}

          {/* Show less button when expanded */}
          {isTruncated && expanded && (
            <div className="flex justify-center pb-2">
              <button
                onClick={() => setExpanded(false)}
                className="text-[12px] cursor-pointer hover:opacity-80 transition-opacity"
                style={{ color: 'var(--claude-text-secondary)' }}
              >
                Show less
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Unknown message type - render as syntax-highlighted JSON with truncation
const UNKNOWN_MSG_MAX_LINES = 5

function UnknownMessageBlock({ message }: { message: SessionMessage }) {
  const [expanded, setExpanded] = useState(false)
  const [html, setHtml] = useState('')

  const jsonText = JSON.stringify(message, null, 2)
  const lines = jsonText.split('\n')
  const isTruncated = lines.length > UNKNOWN_MSG_MAX_LINES
  const displayText = expanded ? jsonText : lines.slice(0, UNKNOWN_MSG_MAX_LINES).join('\n')

  // Get subtype for display
  const subtype = (message as { data?: { type?: string } }).data?.type

  // Highlight JSON with Shiki
  useEffect(() => {
    let cancelled = false

    highlightCode(displayText, 'json').then((highlighted) => {
      if (!cancelled) setHtml(highlighted)
    })

    return () => {
      cancelled = true
    }
  }, [displayText])

  return (
    <div className="flex gap-2">
      <MessageDot type="system" />
      <div className="flex-1 min-w-0 font-mono text-[13px] leading-[1.5]">
        {/* Header: message type + subtype */}
        <div className="font-semibold mb-1" style={{ color: 'var(--claude-text-primary)' }}>
          {message.type}
          {subtype && (
            <span className="ml-1 font-normal" style={{ color: 'var(--claude-text-secondary)' }}>
              ({subtype})
            </span>
          )}
        </div>

        {/* JSON content with Shiki highlighting */}
        <div
          className="rounded-md overflow-hidden"
          style={{ border: '1px solid var(--claude-border-light)' }}
        >
          <div
            className={expanded && isTruncated ? 'overflow-y-auto' : ''}
            style={expanded && isTruncated ? { maxHeight: '60vh' } : {}}
          >
            <div
              className="p-3 text-[12px] [&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:!bg-transparent [&_code]:!bg-transparent"
              style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>

          {/* Show more/less button */}
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
    </div>
  )
}

// Hook block - renders hook_started paired with optional hook_response
function HookBlock({
  hookStarted,
  hookResponse,
}: {
  hookStarted: SessionMessage
  hookResponse?: HookResponseMessage
}) {
  const [isExpanded, setIsExpanded] = useState(false)

  // Determine status based on whether we have a response and its outcome
  const isComplete = !!hookResponse
  const isSuccess = hookResponse?.outcome === 'success'
  const dotType = isComplete ? (isSuccess ? 'tool-completed' as const : 'tool-failed' as const) : 'tool-wip' as const

  // Determine what output to show (prefer stdout, fall back to output field)
  const outputContent = hookResponse?.stdout || hookResponse?.output || ''
  const hasOutput = outputContent.trim().length > 0

  // Format the status text
  const statusText = isComplete
    ? (isSuccess ? 'completed' : 'failed')
    : 'running'

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header line - clickable to expand/collapse when there's output */}
      <button
        type="button"
        onClick={() => hasOutput && setIsExpanded(!isExpanded)}
        className={`flex items-start gap-2 w-full text-left ${hasOutput ? 'hover:opacity-80 transition-opacity cursor-pointer' : ''}`}
        disabled={!hasOutput}
      >
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span style={{ color: 'var(--claude-text-secondary)' }}>
            Hook {statusText}: {hookStarted.hook_name ?? 'unknown'}
          </span>
          {hookResponse?.exit_code !== undefined && hookResponse.exit_code !== 0 && (
            <span style={{ color: 'var(--claude-status-alert)' }}>
              (exit {hookResponse.exit_code})
            </span>
          )}
          {hasOutput && (
            <span
              className="select-none text-[11px]"
              style={{ color: 'var(--claude-text-tertiary)' }}
            >
              {isExpanded ? '▾' : '▸'}
            </span>
          )}
        </div>
      </button>

      {/* Expanded output content with smooth collapse */}
      <div className={`collapsible-grid ${isExpanded && hasOutput ? '' : 'collapsed'}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-2 ml-5 p-3 rounded-md overflow-y-auto whitespace-pre-wrap break-words text-[12px]"
            style={{
              backgroundColor: 'var(--claude-bg-code-block)',
              maxHeight: '40vh',
              color: 'var(--claude-text-secondary)',
            }}
          >
            {outputContent}
          </div>
        </div>
      </div>

      {/* Show stderr if present and different from stdout */}
      <div className={`collapsible-grid ${isExpanded && hookResponse?.stderr && hookResponse.stderr.trim() && hookResponse.stderr !== hookResponse.stdout ? '' : 'collapsed'}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-2 ml-5 p-3 rounded-md overflow-y-auto whitespace-pre-wrap break-words text-[12px]"
            style={{
              backgroundColor: 'var(--claude-bg-code-block)',
              maxHeight: '20vh',
              color: 'var(--claude-status-alert)',
              border: '1px solid var(--claude-status-alert)',
            }}
          >
            <div className="font-semibold mb-1">stderr:</div>
            {hookResponse?.stderr}
          </div>
        </div>
      </div>
    </div>
  )
}

// Format token count to human-readable string (e.g., 61306 → "61K")
function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  return `${Math.round(tokens / 1000)}K`
}

// Task notification block - shows background task completion/failure
function TaskNotificationBlock({ message }: { message: SessionMessage }) {
  // Determine status from message (the JSON has a `status` field on root)
  const taskStatus = (message as unknown as { status?: string }).status ?? 'completed'
  const isCompleted = taskStatus === 'completed'
  const dotType = isCompleted ? 'system' as const : 'tool-failed' as const

  // Summary text from the message
  const summary = message.summary ?? `Background task ${message.task_id ?? 'unknown'} ${taskStatus}`

  // Usage stats (present on agent tasks)
  const usage = message.usage
  const usageParts: string[] = []
  if (usage?.duration_ms != null) usageParts.push(formatDuration(usage.duration_ms))
  if (usage?.tool_uses != null) usageParts.push(`${usage.tool_uses} tool uses`)
  if (usage?.total_tokens != null) usageParts.push(`${formatTokens(usage.total_tokens)} tokens`)
  const usageText = usageParts.length > 0 ? usageParts.join(' · ') : null

  return (
    <div className="flex items-start gap-2">
      <MessageDot type={dotType} />
      <div className="flex-1 min-w-0">
        <span
          className="font-mono text-[13px] leading-[1.5]"
          style={{ color: 'var(--claude-text-secondary)' }}
        >
          {summary}
        </span>
        {usageText && (
          <span
            className="font-mono text-[12px] leading-[1.5] ml-2"
            style={{ color: 'var(--claude-text-tertiary, var(--claude-text-secondary))', opacity: 0.6 }}
          >
            ({usageText})
          </span>
        )}
      </div>
    </div>
  )
}

// Microcompact block - collapsible showing which tools were compacted
function MicrocompactBlock({
  message,
  toolUseMap,
}: {
  message: SessionMessage
  toolUseMap?: Map<string, ToolUseInfo>
}) {
  const [isExpanded, setIsExpanded] = useState(false)

  // Extract microcompact metadata
  const metadata = message.microcompactMetadata
  const compactedToolIds = metadata?.compactedToolIds ?? []
  const tokensSaved = metadata?.tokensSaved ?? 0

  // Map tool IDs to tool info (name + title)
  const compactedTools = compactedToolIds.map((id) => {
    const info = toolUseMap?.get(id)
    return {
      id,
      name: info?.name ?? 'Unknown',
      title: info?.title ?? info?.name ?? 'Unknown',
    }
  })

  const hasDetails = compactedTools.length > 0

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header line - clickable to expand/collapse */}
      <button
        type="button"
        onClick={() => hasDetails && setIsExpanded(!isExpanded)}
        className={`flex items-start gap-2 w-full text-left ${hasDetails ? 'hover:opacity-80 transition-opacity cursor-pointer' : ''}`}
        disabled={!hasDetails}
      >
        <MessageDot type="system" />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span
            className="font-semibold"
            style={{ color: 'var(--claude-text-primary)' }}
          >
            Context microcompacted
          </span>
          <span style={{ color: 'var(--claude-text-tertiary)' }}>
            ({compactedTools.length} tool{compactedTools.length !== 1 ? 's' : ''}, {tokensSaved.toLocaleString()} tokens saved)
          </span>
          {hasDetails && (
            <span
              className="select-none text-[11px]"
              style={{ color: 'var(--claude-text-tertiary)' }}
            >
              {isExpanded ? '▾' : '▸'}
            </span>
          )}
        </div>
      </button>

      {/* Expanded content - list of compacted tools with smooth collapse */}
      <div className={`collapsible-grid ${isExpanded && hasDetails ? '' : 'collapsed'}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-2 ml-5 flex flex-col gap-1"
            style={{ color: 'var(--claude-text-secondary)' }}
          >
            {compactedTools.map((tool) => (
              <div key={tool.id} className="flex items-center gap-2">
                <span className="select-none">└</span>
                <span>{tool.name}</span>
                <span style={{ color: 'var(--claude-text-tertiary)' }}>
                  {tool.title !== tool.name && tool.title}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
