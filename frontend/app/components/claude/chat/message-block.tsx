import { ToolBlock } from './tool-block'
import type { Message } from '~/types/claude'
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
          {message.toolCalls.map((toolCall) => (
            <ToolBlock key={toolCall.id} toolCall={toolCall} />
          ))}
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
