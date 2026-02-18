import { useStickToBottom } from 'use-stick-to-bottom'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { SessionMessages } from './session-messages'
import { ClaudeWIP } from './claude-wip'
import { StreamingResponse } from './streaming-response'
import { StreamingThinking } from './streaming-thinking'
import type { SessionMessage, ExtractedToolResult } from '~/lib/session-message-utils'

interface MessageListProps {
  messages: SessionMessage[]
  toolResultMap: Map<string, ExtractedToolResult>
  optimisticMessage?: string | null
  /** Streaming text from stream_event messages (progressive response display) */
  streamingText?: string
  /** Streaming thinking from stream_event thinking_delta messages (progressive thinking display) */
  streamingThinking?: string
  wipText?: string | null
  /** Callback to receive the scroll container element for external use (e.g., hide-on-scroll) */
  onScrollElementReady?: (element: HTMLDivElement | null) => void
}

/**
 * MessageList - Top-level message container with scroll behavior
 *
 * This component handles:
 * - Scroll container with stick-to-bottom behavior (via use-stick-to-bottom library)
 * - Empty state when no messages
 * - Optimistic user message display
 * - Work-in-progress indicator
 *
 * The use-stick-to-bottom library automatically handles:
 * - Sticking to bottom when new content is added
 * - Allowing user to scroll up to break sticky behavior
 * - Re-engaging sticky when user scrolls back to bottom
 *
 * Additional mobile fix:
 * - Manual scroll listener re-engages sticky when user scrolls to the bottom
 * - Fixes issue where library doesn't re-engage after mobile momentum scrolling
 *
 * For the actual message rendering, it delegates to SessionMessages,
 * which can be used recursively for nested agent sessions.
 */
export function MessageList({ messages, toolResultMap, optimisticMessage, streamingText, streamingThinking, wipText, onScrollElementReady }: MessageListProps) {
  // use-stick-to-bottom with velocity-based spring animations
  // 'smooth' enables natural deceleration for streaming content
  // This adapts scroll speed to distance - faster when far behind, slower when close
  const { scrollRef, contentRef, scrollToBottom } = useStickToBottom({
    initial: 'smooth',
    resize: 'smooth',
  })

  // Track scroll element for parent callback and scroll listeners
  const scrollElementRef = useRef<HTMLDivElement | null>(null)

  // Merge refs: assign to useStickToBottom's scrollRef AND notify parent
  const mergedScrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollElementRef.current = element
      // Assign to useStickToBottom's ref
      if (typeof scrollRef === 'function') {
        scrollRef(element)
      } else if (scrollRef) {
        ;(scrollRef as React.RefObject<HTMLDivElement | null>).current = element
      }
      // Notify parent for hide-on-scroll
      onScrollElementReady?.(element)
    },
    [scrollRef, onScrollElementReady]
  )

  // Re-engage sticky when user scrolls to the bottom
  // The library doesn't always re-engage on mobile after momentum scrolling
  useEffect(() => {
    const element = scrollElementRef.current
    if (!element) return

    const checkAndReengage = () => {
      const { scrollTop, scrollHeight, clientHeight } = element
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight

      // Re-engage sticky when at the very bottom (within 1px for rounding)
      if (distanceFromBottom <= 1) {
        scrollToBottom({ animation: 'instant' })
      }
    }

    element.addEventListener('scroll', checkAndReengage, { passive: true })
    element.addEventListener('scrollend', checkAndReengage, { passive: true })

    return () => {
      element.removeEventListener('scroll', checkAndReengage)
      element.removeEventListener('scrollend', checkAndReengage)
    }
  }, [scrollToBottom])

  // Only show StreamingResponse when streaming text exists AND the final assistant
  // message hasn't been added to the messages list yet. Once the assistant message
  // appears in the list, MessageBlock renders it with sync-parsed markdown immediately,
  // so we hide StreamingResponse to avoid showing duplicate content.
  const showStreaming = useMemo(() => {
    if (!streamingText) return false
    // If the last message is an assistant message, the final content is in the list —
    // MessageBlock will render it with immediate sync-parsed HTML
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.type === 'assistant') return false
    return true
  }, [streamingText, messages])

  // Only show StreamingThinking when thinking text exists AND the final assistant
  // message hasn't arrived yet. Same logic as showStreaming — once the assistant
  // message is in the list, it contains the completed thinking block.
  const showStreamingThinking = useMemo(() => {
    if (!streamingThinking) return false
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.type === 'assistant') return false
    return true
  }, [streamingThinking, messages])

  return (
    <div
      ref={mergedScrollRef}
      className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 min-w-0 claude-interface claude-bg"
    >
      <div ref={contentRef} className="w-full max-w-4xl mx-auto px-6 md:px-8 py-8 flex flex-col min-h-full">
        {messages.length === 0 && !optimisticMessage ? (
          <div className="flex-1" />
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

            {/* Streaming thinking (progressive thinking as Claude reasons)
              * Shown BEFORE streaming text since thinking precedes text in Claude's response.
              * Hide once the final assistant message arrives (it contains the completed thinking block). */}
            {showStreamingThinking && <StreamingThinking text={streamingThinking} />}

            {/* Streaming response (progressive text as Claude generates)
              * Hide once the final assistant message is in the list to avoid duplicate content.
              * The MessageBlock's MessageContent uses parseMarkdownSync for immediate render,
              * ensuring a seamless visual transition with no flash. */}
            {showStreaming && <StreamingResponse text={streamingText} />}

            {/* Work-in-Progress indicator */}
            {wipText && <ClaudeWIP text={wipText} />}
          </>
        )}
      </div>
    </div>
  )
}
