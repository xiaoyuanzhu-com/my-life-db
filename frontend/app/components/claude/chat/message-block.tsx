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
  isCompactSummaryMessage,
  type SessionMessage,
  type ExtractedToolResult,
} from '~/lib/session-message-utils'
import { parseMarkdown, onMermaidThemeChange } from '~/lib/shiki'
import { useEffect, useState, useMemo } from 'react'

interface MessageBlockProps {
  message: SessionMessage
  toolResultMap: Map<string, ExtractedToolResult>
}

export function MessageBlock({ message, toolResultMap }: MessageBlockProps) {
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

  // Check for compact boundary and compact summary
  const isCompactBoundary = isCompactBoundaryMessage(message)
  const isCompactSummary = isCompactSummaryMessage(message)

  // Determine what to render
  const hasUserContent = isUser && userTextContent && !isCompactSummary
  const hasAssistantText = isAssistant && textContent
  const hasThinking = thinkingBlocks.length > 0
  const hasToolCalls = toolCalls.length > 0
  const hasSystemInit = systemInitData !== null
  const hasUnknownSystem = isSystem && !hasSystemInit && !isCompactBoundary

  // Skip rendering if there's nothing to show
  if (!hasUserContent && !hasAssistantText && !hasThinking && !hasToolCalls && !hasSystemInit && !isCompactBoundary && !isCompactSummary && !hasUnknownSystem) {
    return null
  }

  return (
    <div className="mb-4">
      {/* User messages: gray background pill, right-aligned */}
      {hasUserContent && <UserMessageBlock content={userTextContent!} />}

      {/* System init messages: special formatted display */}
      {hasSystemInit && (
        <div className="flex items-start gap-2">
          <MessageDot status="completed" lineHeight="mono" />
          <div className="flex-1 min-w-0">
            <SystemInitBlock data={systemInitData!} />
          </div>
        </div>
      )}

      {/* Compact boundary: system message style (matches Bash tool title) */}
      {isCompactBoundary && (
        <div className="flex items-start gap-2">
          <MessageDot status="completed" lineHeight="mono" />
          <span
            className="font-mono text-[13px] leading-[1.5] font-semibold"
            style={{ color: 'var(--claude-text-primary)' }}
          >
            Session compacted
          </span>
        </div>
      )}

      {/* Compact summary: collapsible markdown content */}
      {isCompactSummary && userTextContent && (
        <CompactSummaryBlock content={userTextContent} />
      )}

      {/* Unknown system messages: render raw JSON for debugging */}
      {hasUnknownSystem && (
        <div className="flex gap-2">
          <MessageDot status="assistant" lineHeight="prose" />
          <div className="flex-1 min-w-0">
            <div
              className="text-sm font-medium mb-1"
              style={{ color: 'var(--claude-text-secondary)' }}
            >
              {message.type}
            </div>
            <pre
              className="text-xs font-mono px-3 py-2 rounded overflow-x-auto"
              style={{
                color: 'var(--claude-text-secondary)',
                backgroundColor: 'var(--claude-bg-code-block)',
              }}
            >
              <code>{JSON.stringify(message, null, 2)}</code>
            </pre>
          </div>
        </div>
      )}

      {/* Assistant messages: bullet + markdown content */}
      {hasAssistantText && (
        <div className="flex gap-2">
          <MessageDot status="assistant" lineHeight="prose" />
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
          <ToolCallGroups toolCalls={toolCalls} />
        </div>
      )}
    </div>
  )
}


// Group consecutive tool calls of the same type
function ToolCallGroups({ toolCalls }: { toolCalls: ToolCall[] }) {
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
          return <ToolBlock key={group[0].id} toolCall={group[0]} />
        }

        // Multiple tool calls of same type - render as collapsible group
        return <ToolCallGroup key={`group-${groupIndex}`} toolCalls={group} />
      })}
    </>
  )
}

// Collapsible group for multiple tool calls of the same type
function ToolCallGroup({ toolCalls }: { toolCalls: ToolCall[] }) {
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

      {/* Individual tool calls - indented */}
      {isExpanded && (
        <div className="ml-6 mt-2 space-y-2">
          {toolCalls.map((toolCall) => (
            <ToolBlock key={toolCall.id} toolCall={toolCall} />
          ))}
        </div>
      )}
    </div>
  )
}

// Markdown content renderer using marked + shiki
function MessageContent({ content }: { content: string }) {
  const [html, setHtml] = useState('')
  const [themeKey, setThemeKey] = useState(0)

  // Re-render when theme changes (for mermaid diagrams)
  useEffect(() => {
    return onMermaidThemeChange(() => setThemeKey((k) => k + 1))
  }, [])

  useEffect(() => {
    let cancelled = false

    parseMarkdown(content).then((parsed) => {
      if (!cancelled) setHtml(parsed)
    })

    return () => {
      cancelled = true
    }
  }, [content, themeKey])

  return (
    <div
      className="prose-claude"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

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
        <MessageDot status="assistant" lineHeight="mono" />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span
            className="font-semibold italic"
            style={{ color: 'var(--claude-text-secondary)' }}
          >
            Extended Thinking
          </span>
          <span
            className="select-none text-[11px]"
            style={{ color: 'var(--claude-text-tertiary)' }}
          >
            {isExpanded ? '▾' : '▸'}
          </span>
        </div>
      </button>

      {/* Expanded content - rendered as markdown */}
      {isExpanded && (
        <div
          className="mt-2 ml-5 p-4 rounded-md prose-claude overflow-y-auto"
          style={{
            backgroundColor: 'var(--claude-bg-code-block)',
            maxHeight: '60vh',
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
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
      <MessageDot status="completed" lineHeight="mono" />
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
function UserMessageBlock({ content }: { content: string }) {
  const { context, message } = splitMessageContent(content)

  return (
    <div className="flex flex-col items-end gap-1">
      {/* File context shown above the message bubble */}
      {context}

      {/* Message bubble - only show if there's actual message content */}
      {message && (
        <div
          className="inline-block px-4 py-3 rounded-xl text-[15px] leading-relaxed"
          style={{
            backgroundColor: 'var(--claude-bg-subtle)',
            color: 'var(--claude-text-primary)',
          }}
        >
          {message}
        </div>
      )}
    </div>
  )
}
