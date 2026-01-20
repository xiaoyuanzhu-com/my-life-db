import { MessageBlock } from './message-block'
import type { Message } from '~/types/claude'

interface MessageListProps {
  messages: Message[]
  streamingContent?: string
}

export function MessageList({ messages, streamingContent }: MessageListProps) {
  return (
    <div className="flex-1 overflow-y-auto claude-interface flex flex-col-reverse">
      {/* Centered content container - max-w-3xl like official UI */}
      <div className="max-w-3xl mx-auto px-6 py-8 flex flex-col-reverse">
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

            {/* Messages in reverse order (newest at bottom) */}
            {[...messages].reverse().map((message) => (
              <MessageBlock key={message.id} message={message} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
