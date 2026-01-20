import { ToolBlock } from './tool-block'
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
      {/* User messages: minimal styling, left-aligned */}
      {isUser && message.content && (
        <div className="text-[15px] leading-relaxed" style={{ color: 'var(--claude-text-primary)' }}>
          {message.content}
        </div>
      )}

      {/* Assistant messages: markdown content */}
      {!isUser && message.content && (
        <div className="pl-0">
          <MessageContent content={message.content} />
          {message.isStreaming && (
            <span
              className="inline-block w-[10px] h-[18px] ml-1 align-middle"
              style={{ backgroundColor: 'var(--claude-text-primary)' }}
            >
              █
            </span>
          )}
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
      className="max-w-none text-[15px] leading-relaxed
        [&_p]:my-4
        [&_h1]:text-[16px] [&_h1]:font-bold [&_h1]:leading-[1.5] [&_h1]:mb-3 [&_h1]:mt-4
        [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:leading-[1.5] [&_h2]:mb-3 [&_h2]:mt-4
        [&_h3]:text-[16px] [&_h3]:font-semibold [&_h3]:leading-[1.5] [&_h3]:mb-2 [&_h3]:mt-3
        [&_ul]:my-4 [&_ul]:pl-6 [&_ul]:list-disc
        [&_ol]:my-4 [&_ol]:pl-6 [&_ol]:list-decimal
        [&_li]:mb-1
        [&_code]:font-mono [&_code]:text-[13px] [&_code]:px-[5px] [&_code]:py-[2px] [&_code]:rounded
        [&_code]:before:content-none [&_code]:after:content-none
        [&_pre]:my-3 [&_pre]:p-4 [&_pre]:rounded-lg [&_pre]:overflow-x-auto
        [&_pre_code]:p-0 [&_pre_code]:bg-transparent [&_pre_code]:text-[13px] [&_pre_code]:leading-[1.5]
        [&_strong]:font-semibold
        [&_a]:underline [&_a]:underline-offset-2"
      style={{
        color: 'var(--claude-text-primary)',
        '--code-bg': 'var(--claude-bg-inline)',
        '--code-color': 'var(--claude-text-primary)',
        '--pre-bg': 'var(--claude-bg-code-block)',
      } as React.CSSProperties & { '--code-bg': string; '--code-color': string; '--pre-bg': string }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
