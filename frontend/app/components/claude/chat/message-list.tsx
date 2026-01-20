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
  const isInitialMount = useRef(true)

  // Auto-scroll to bottom when new messages arrive OR on initial load
  useEffect(() => {
    if (isInitialMount.current && messages.length > 0) {
      // On initial mount with messages, scroll immediately without animation
      bottomRef.current?.scrollIntoView({ behavior: 'instant' })
      isInitialMount.current = false
    } else if (!isInitialMount.current) {
      // Subsequent updates: smooth scroll
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, streamingContent])

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto claude-interface"
    >
      {/* Centered content container - max-w-3xl like official UI */}
      <div className="max-w-3xl mx-auto px-6 py-8">
        {messages.length === 0 && !streamingContent ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center" style={{ color: 'var(--claude-text-secondary)' }}>
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
    </div>
  )
}
