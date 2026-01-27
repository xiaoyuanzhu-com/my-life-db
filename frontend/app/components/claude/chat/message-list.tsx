import { useStickToBottom } from 'use-stick-to-bottom'
import { useCallback } from 'react'
import { SessionMessages } from './session-messages'
import { ClaudeWIP } from './claude-wip'
import type { SessionMessage, ExtractedToolResult } from '~/lib/session-message-utils'

interface MessageListProps {
  messages: SessionMessage[]
  toolResultMap: Map<string, ExtractedToolResult>
  optimisticMessage?: string | null
  wipText?: string | null
  /** Callback to receive the scroll container element for external use (e.g., hide-on-scroll) */
  onScrollElementReady?: (element: HTMLDivElement | null) => void
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
export function MessageList({ messages, toolResultMap, optimisticMessage, wipText, onScrollElementReady }: MessageListProps) {
  const { scrollRef, contentRef } = useStickToBottom({
    initial: 'instant',
    resize: 'instant',
  })

  // Merge refs: assign to useStickToBottom's scrollRef AND notify parent
  const mergedScrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      // Assign to useStickToBottom's ref
      if (typeof scrollRef === 'function') {
        scrollRef(element)
      } else if (scrollRef) {
        ;(scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = element
      }
      // Notify parent for hide-on-scroll
      onScrollElementReady?.(element)
    },
    [scrollRef, onScrollElementReady]
  )

  return (
    <div
      ref={mergedScrollRef}
      className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 claude-interface claude-bg"
    >
      <div ref={contentRef} className="w-full max-w-4xl mx-auto px-6 md:px-8 py-8">
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
                    className="inline-block max-w-[85%] px-4 py-3 rounded-xl text-[15px] leading-relaxed whitespace-pre-wrap break-words opacity-70"
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
