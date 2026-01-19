import { User, Bot } from 'lucide-react'
import { ToolBlock } from './tool-block'
import { cn } from '~/lib/utils'
import type { Message } from '~/types/claude'

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

// Simple markdown-like content renderer
function MessageContent({ content }: { content: string }) {
  // Split content by code blocks
  const parts = content.split(/(```[\s\S]*?```|`[^`]+`)/g)

  return (
    <div className="whitespace-pre-wrap break-words">
      {parts.map((part, index) => {
        // Fenced code block
        if (part.startsWith('```')) {
          const match = part.match(/```(\w+)?\n?([\s\S]*?)```/)
          if (match) {
            const [, lang, code] = match
            return (
              <pre
                key={index}
                className="my-2 p-3 bg-background/50 rounded-md overflow-x-auto text-xs font-mono"
              >
                {lang && (
                  <div className="text-muted-foreground text-xs mb-2">{lang}</div>
                )}
                <code>{code.trim()}</code>
              </pre>
            )
          }
        }

        // Inline code
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code
              key={index}
              className="px-1 py-0.5 bg-background/50 rounded text-xs font-mono"
            >
              {part.slice(1, -1)}
            </code>
          )
        }

        // Regular text - handle bold and italic
        return (
          <span key={index}>
            {part.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((textPart, i) => {
              if (textPart.startsWith('**') && textPart.endsWith('**')) {
                return <strong key={i}>{textPart.slice(2, -2)}</strong>
              }
              if (textPart.startsWith('*') && textPart.endsWith('*')) {
                return <em key={i}>{textPart.slice(1, -1)}</em>
              }
              return textPart
            })}
          </span>
        )
      })}
    </div>
  )
}
