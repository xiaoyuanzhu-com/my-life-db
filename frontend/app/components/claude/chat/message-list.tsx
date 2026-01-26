import { useStickToBottom } from 'use-stick-to-bottom'
import { SessionMessages } from './session-messages'
import { ClaudeWIP } from './claude-wip'
import type { SessionMessage, ExtractedToolResult } from '~/lib/session-message-utils'

interface MessageListProps {
  messages: SessionMessage[]
  toolResultMap: Map<string, ExtractedToolResult>
  optimisticMessage?: string | null
  wipText?: string | null
}

/**
 * MessageList - Top-level message container with scroll behavior
 *
 * This component handles:
 * - Scroll container with stick-to-bottom behavior
 * - Empty state when no messages
 * - Optimistic user message display
 * - Work-in-progress indicator
 *
 * For the actual message rendering, it delegates to SessionMessages,
 * which can be used recursively for nested agent sessions.
 */
export function MessageList({ messages, toolResultMap, optimisticMessage, wipText }: MessageListProps) {
  const { scrollRef, contentRef } = useStickToBottom({
    initial: 'instant',
    resize: 'instant',
  })

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto claude-interface claude-bg"
    >
      <div ref={contentRef} className="max-w-3xl mx-auto px-6 py-8">
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
            {/* Messages rendered via SessionMessages (supports recursive nesting) */}
            <SessionMessages
              messages={messages}
              toolResultMap={toolResultMap}
              depth={0}
            />

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

            {/* Work-in-Progress indicator */}
            {wipText && <ClaudeWIP text={wipText} />}
          </>
        )}
      </div>
    </div>
  )
}
