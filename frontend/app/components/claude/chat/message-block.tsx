import { User, Bot } from 'lucide-react'
import { ToolBlock } from './tool-block'
import { cn } from '~/lib/utils'
import type { Message } from '~/types/claude'
import { marked } from 'marked'
import { useEffect, useState } from 'react'

interface MessageBlockProps {
  message: Message
}

export function MessageBlock({ message }: MessageBlockProps) {
  const isUser = message.role === 'user'

  return (
    <div
      className={cn(
        'flex gap-3',
        isUser && 'flex-row-reverse'
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'
        )}
      >
        {isUser ? (
          <User className="h-4 w-4" />
        ) : (
          <Bot className="h-4 w-4" />
        )}
      </div>

      {/* Content */}
      <div
        className={cn(
          'flex-1 max-w-[85%] space-y-2',
          isUser && 'text-right'
        )}
      >
        {/* Message text */}
        {message.content && (
          <div
            className={cn(
              'inline-block rounded-lg px-4 py-2 text-sm',
              isUser
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-foreground'
            )}
          >
            <MessageContent content={message.content} />
            {message.isStreaming && (
              <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse" />
            )}
          </div>
        )}

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="space-y-2 text-left">
            {message.toolCalls.map((toolCall) => (
              <ToolBlock key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        )}

        {/* Timestamp */}
        <div className="text-xs text-muted-foreground">
          {new Date(message.timestamp).toLocaleTimeString()}
        </div>
      </div>
    </div>
  )
}

// Configure marked for safe rendering
marked.setOptions({
  breaks: true, // Convert \n to <br>
  gfm: true, // GitHub Flavored Markdown
})

// Markdown content renderer using marked
function MessageContent({ content }: { content: string }) {
  const [html, setHtml] = useState('')

  useEffect(() => {
    // Parse markdown to HTML (synchronous in marked v17)
    const parsed = marked.parse(content)
    setHtml(parsed as string)
  }, [content])

  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none
        prose-pre:bg-zinc-900 prose-pre:text-zinc-100
        prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
        prose-code:before:content-none prose-code:after:content-none
        prose-p:my-1 prose-ul:my-1 prose-ol:my-1
        prose-headings:mt-3 prose-headings:mb-2"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
