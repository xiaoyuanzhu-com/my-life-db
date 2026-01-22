import { MessageBlock } from './message-block'
import type { SessionMessage, ExtractedToolResult } from '~/lib/session-message-utils'

interface MessageListProps {
  messages: SessionMessage[]
  toolResultMap: Map<string, ExtractedToolResult>
  optimisticMessage?: string | null
}

export function MessageList({ messages, toolResultMap, optimisticMessage }: MessageListProps) {
  return (
    <div className="flex-1 overflow-y-auto claude-interface flex flex-col-reverse">
      {/* Centered content container - max-w-3xl like official UI */}
      <div className="max-w-3xl mx-auto px-6 py-8 flex flex-col-reverse">
        {messages.length === 0 && !optimisticMessage ? (
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
            {/* Optimistic user message (shown before server confirms) */}
            {optimisticMessage && (
              <div className="mb-4">
                <div className="flex flex-col items-end">
                  <div
                    className="inline-block px-4 py-3 rounded-xl text-[15px] leading-relaxed opacity-70"
                    style={{
                      backgroundColor: 'var(--claude-bg-subtle)',
                      color: 'var(--claude-text-primary)',
                    }}
                  >
                    {optimisticMessage}
                  </div>
                </div>
              </div>
            )}
            {/* Messages in reverse order (newest at bottom) */}
            {[...messages].reverse().map((message) => (
              <MessageBlock
                key={message.uuid}
                message={message}
                toolResultMap={toolResultMap}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
