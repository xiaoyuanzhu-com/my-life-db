import { ToolBlock } from './tool-block'
import { MessageDot } from './message-dot'
import type { Message, ToolCall } from '~/types/claude'
import { marked } from 'marked'
import { useEffect, useState } from 'react'

interface MessageBlockProps {
  message: Message
}

export function MessageBlock({ message }: MessageBlockProps) {
  const isUser = message.role === 'user'

  return (
    <div className="mb-4">
      {/* User messages: gray background pill, right-aligned */}
      {isUser && message.content && (
        <div className="flex justify-end">
          <div
            className="inline-block px-4 py-3 rounded-xl text-[15px] leading-relaxed"
            style={{
              backgroundColor: 'var(--claude-bg-subtle)',
              color: 'var(--claude-text-primary)',
            }}
          >
            {message.content}
          </div>
        </div>
      )}

      {/* Assistant messages: bullet + markdown content */}
      {!isUser && (message.content || message.thinking) && (
        <div className="flex gap-2">
          <MessageDot status="assistant" size="prose" />
          <div className="flex-1 min-w-0">
            {message.content && <MessageContent content={message.content} />}
            {message.thinking && <ThinkingBlocks thinking={message.thinking} />}
            {message.isStreaming && (
              <span
                className="inline-block w-[10px] h-[18px] ml-1 align-middle"
                style={{ backgroundColor: 'var(--claude-text-primary)' }}
              >
                █
              </span>
            )}
          </div>
        </div>
      )}

      {/* Tool calls */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mt-3 space-y-2">
          <ToolCallGroups toolCalls={message.toolCalls} />
        </div>
      )}
    </div>
  )
}

// Configure marked for safe rendering
marked.setOptions({
  breaks: true, // Convert \n to <br>
  gfm: true, // GitHub Flavored Markdown
})

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

// Markdown content renderer using marked - Claude Code style
function MessageContent({ content }: { content: string }) {
  const [html, setHtml] = useState('')

  useEffect(() => {
    // Parse markdown to HTML (synchronous in marked v17)
    const parsed = marked.parse(content)
    setHtml(parsed as string)
  }, [content])

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

  return (
    <div className="my-2">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="font-mono text-[13px] leading-[1.5] flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity italic"
        style={{ color: 'var(--claude-text-secondary)' }}
      >
        <span className="select-none">{isExpanded ? '▼' : '▶'}</span>
        <span>Extended thinking</span>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div
          className="mt-2 ml-6 p-3 rounded-lg font-mono text-[13px] leading-[1.5] whitespace-pre-wrap"
          style={{
            backgroundColor: 'var(--claude-bg-code-block)',
            color: 'var(--claude-text-secondary)',
          }}
        >
          {block.thinking}
        </div>
      )}
    </div>
  )
}
