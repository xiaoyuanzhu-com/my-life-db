import { useEffect, useRef } from 'react'
import { MessageBlock } from './message-block'
import type { Message } from '~/types/claude'

interface MessageListProps {
  messages: Message[]
  streamingContent?: string
}

export function MessageList({ messages, streamingContent }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent])

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto p-4 space-y-4"
    >
      {messages.length === 0 && !streamingContent ? (
        <div className="flex h-full items-center justify-center">
          <div className="text-center text-muted-foreground">
            <p className="text-lg font-medium">Start a conversation</p>
            <p className="text-sm mt-1">
              Type a message below to begin working with Claude
            </p>
          </div>
        </div>
      ) : (
        <>
          {messages.map((message) => (
            <MessageBlock key={message.id} message={message} />
          ))}

          {/* Streaming message */}
          {streamingContent && (
            <MessageBlock
              message={{
                id: 'streaming',
                role: 'assistant',
                content: streamingContent,
                timestamp: Date.now(),
                isStreaming: true,
              }}
            />
          )}
        </>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
