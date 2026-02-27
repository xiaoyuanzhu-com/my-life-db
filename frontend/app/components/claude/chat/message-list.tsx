import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useStickToBottom } from '~/hooks/use-stick-to-bottom'
import { useFilteredMessages } from './use-filtered-messages'
import { TransientStatusBlock } from './session-messages'
import { MessageBlock } from './message-block'
import { ClaudeWIP } from './claude-wip'
import { StreamingResponse } from './streaming-response'
import { StreamingThinking } from './streaming-thinking'
import { isTextBlock } from '~/lib/session-message-utils'
import type { SessionMessage, ExtractedToolResult, ContentBlock } from '~/lib/session-message-utils'

interface MessageListProps {
  messages: SessionMessage[]
  toolResultMap: Map<string, ExtractedToolResult>
  optimisticMessage?: string | null
  /** Streaming text from stream_event messages (progressive response display) */
  streamingText?: string
  /** Streaming thinking from stream_event thinking_delta messages (progressive thinking display) */
  streamingThinking?: string
  /** Turn counter — incremented each turn so ClaudeWIP picks fresh random words per turn */
  turnId?: number
  wipText?: string | null
  /** Callback to receive the scroll container element for external use (e.g., hide-on-scroll) */
  onScrollElementReady?: (element: HTMLDivElement | null) => void
  /** Whether a page of older messages is currently being loaded */
  isLoadingPage?: boolean
  /** Whether there are more historical pages available to load */
  hasMoreHistory?: boolean
  /** Callback to load the next older page of messages */
  onLoadOlderPage?: () => void
}

/**
 * MessageList - Top-level message container with virtual scrolling
 *
 * This component handles:
 * - Virtual scrolling via @tanstack/react-virtual (only visible items are in the DOM)
 * - Scroll container with stick-to-bottom behavior (via custom useStickToBottom hook)
 * - Empty state when no messages
 * - Optimistic user message display
 * - Work-in-progress indicator
 * - Scroll-up detection for loading older message pages
 * - Scroll position preservation when prepending older messages
 * - Adaptive viewport fill (loads more pages if content doesn't fill viewport)
 * - Streaming display (StreamingResponse, StreamingThinking, ClaudeWIP)
 * - TransientStatusBlock for ephemeral session status (e.g., compacting)
 *
 * The useStickToBottom hook handles:
 * - Sticking to bottom when new content is added
 * - Allowing user to scroll up to break sticky behavior
 * - Re-engaging sticky when user scrolls back to bottom
 * - Mobile momentum scrolling via scroll + scrollend events
 *
 * For actual message rendering, each virtual item renders a MessageBlock directly.
 * SessionMessages is still used for nested Task tool conversations (depth > 0).
 */
export function MessageList({ messages, toolResultMap, optimisticMessage, streamingText, streamingThinking, turnId, wipText, onScrollElementReady, isLoadingPage, hasMoreHistory, onLoadOlderPage }: MessageListProps) {
  // Filter messages and build lookup maps (same logic as SessionMessages uses for depth > 0)
  const { filteredMessages, maps, currentStatus } = useFilteredMessages(
    messages,
    toolResultMap,
    0, // depth = 0 for top-level
  )

  // Stick-to-bottom: replaces the `use-stick-to-bottom` npm library
  const { isAtBottom, scrollToBottom, setScrollElement, onContentChange } = useStickToBottom()

  // Track scroll element for parent callback and scroll listeners
  const scrollElementRef = useRef<HTMLDivElement | null>(null)

  // Track previous message count for scroll position preservation on prepend
  const prevMessageCountRef = useRef(filteredMessages.length)
  const prevScrollHeightRef = useRef(0)
  const prevScrollTopRef = useRef(0)

  // Merged ref callback: assigns to useStickToBottom's setScrollElement AND stores locally
  const mergedScrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollElementRef.current = element
      // Assign to useStickToBottom's callback ref (sets up scroll/scrollend listeners)
      setScrollElement(element)
      // Notify parent for hide-on-scroll
      onScrollElementReady?.(element)
    },
    [setScrollElement, onScrollElementReady]
  )

  // ============================================================================
  // Virtualizer
  // ============================================================================

  const virtualizer = useVirtualizer({
    count: filteredMessages.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 120,
    overscan: 5,
    getItemKey: (index) => filteredMessages[index]?.uuid ?? index,
    // measureElement is used as a ref callback on each virtual item wrapper.
    // It uses ResizeObserver internally to detect size changes dynamically.
  })

  // Auto-scroll when new content arrives and user is at bottom
  useEffect(() => {
    onContentChange()
  }, [filteredMessages.length, streamingText, streamingThinking, wipText, optimisticMessage, currentStatus, onContentChange])

  // ============================================================================
  // Scroll event handlers
  // ============================================================================

  // Scroll-up detection: load older pages when user scrolls near the top
  useEffect(() => {
    const element = scrollElementRef.current
    if (!element) return

    const handleScroll = () => {
      // Trigger load when within 300px of the top
      if (element.scrollTop < 300 && hasMoreHistory && !isLoadingPage) {
        onLoadOlderPage?.()
      }
    }

    element.addEventListener('scroll', handleScroll, { passive: true })
    return () => element.removeEventListener('scroll', handleScroll)
  }, [hasMoreHistory, isLoadingPage, onLoadOlderPage])

  // ============================================================================
  // Scroll position preservation on prepend
  // ============================================================================

  // Uses useLayoutEffect (not useEffect) so the scroll adjustment happens
  // synchronously after DOM mutations but BEFORE the browser paints the frame.
  // With useEffect the browser would paint the post-prepend layout (scroll jumps
  // to top) before the effect ran — causing a visible flash. useLayoutEffect
  // eliminates that single-frame jump entirely.
  //
  // How it works:
  //   prevScrollHeightRef / prevScrollTopRef hold values from the *last* layout.
  //   When messages are prepended, scrollHeight grows by the height of the new
  //   content. We shift scrollTop by the same delta so the visible content stays
  //   in place. Only triggered when the user was near the top (scrollTop < 300),
  //   which is the condition that triggered the older-page load in the first place.
  useLayoutEffect(() => {
    const element = scrollElementRef.current
    if (!element) return

    const prevCount = prevMessageCountRef.current
    const currentCount = filteredMessages.length

    if (currentCount > prevCount && prevScrollHeightRef.current > 0) {
      // Messages were added. Check if they were prepended (older page loaded)
      // by comparing scroll heights — if content grew above the viewport, adjust.
      const heightDelta = element.scrollHeight - prevScrollHeightRef.current
      if (heightDelta > 0 && prevScrollTopRef.current < 300) {
        // User was near the top (waiting for older messages) — preserve position
        element.scrollTop = prevScrollTopRef.current + heightDelta
      }
    }

    // Save current state for next comparison
    prevMessageCountRef.current = currentCount
    prevScrollHeightRef.current = element.scrollHeight
    prevScrollTopRef.current = element.scrollTop
  }, [filteredMessages.length])

  // ============================================================================
  // Adaptive viewport fill + stuck-at-top recovery
  // ============================================================================

  // After a page load completes (isLoadingPage false→true→false), check if we
  // still need more content. This covers two cases:
  // 1. Content doesn't fill the viewport — keep loading until it does
  // 2. User scrolled to top fast and is stuck there — no scroll event will fire,
  //    so we re-trigger the load if still near the top
  useEffect(() => {
    const element = scrollElementRef.current
    if (!element || isLoadingPage || !hasMoreHistory || filteredMessages.length === 0) return

    // Use requestAnimationFrame to check after the browser has finished layout
    const rafId = requestAnimationFrame(() => {
      if (element.scrollHeight <= element.clientHeight || element.scrollTop < 300) {
        onLoadOlderPage?.()
      }
    })

    return () => cancelAnimationFrame(rafId)
  }, [filteredMessages.length, isLoadingPage, hasMoreHistory, onLoadOlderPage])

  // ============================================================================
  // Streaming visibility logic
  // ============================================================================

  // Only show StreamingResponse when streaming text exists AND the final assistant
  // message (with text content) hasn't been added to the messages list yet.
  // Once that message appears, MessageBlock renders it with sync-parsed markdown
  // immediately, so we hide StreamingResponse to avoid duplicate content.
  //
  // IMPORTANT: We check for text content specifically because after a tool use,
  // the last renderable message is an assistant message with only tool_use blocks
  // (the tool_result user message is filtered from renderableMessages). That
  // tool_use-only assistant message is NOT the final response — streaming is for
  // the NEXT response. Without this check, streaming after tool use would be hidden.
  const showStreaming = useMemo(() => {
    if (!streamingText) return false
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.type === 'assistant') {
      const content = lastMsg.message?.content
      if (Array.isArray(content) && content.some((b: ContentBlock) => isTextBlock(b))) {
        return false
      }
    }
    return true
  }, [streamingText, messages])

  // Only show StreamingThinking when thinking text exists AND the final assistant
  // message (with text content) hasn't arrived yet. Same logic as showStreaming.
  const showStreamingThinking = useMemo(() => {
    if (!streamingThinking) return false
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.type === 'assistant') {
      const content = lastMsg.message?.content
      if (Array.isArray(content) && content.some((b: ContentBlock) => isTextBlock(b))) {
        return false
      }
    }
    return true
  }, [streamingThinking, messages])

  // ============================================================================
  // onHeightChange callback for virtualizer re-measurement
  // ============================================================================

  // When a collapsible section expands/collapses, the virtualizer's ResizeObserver
  // should catch the size change via measureElement. This callback is a safety net
  // that also triggers onContentChange to auto-scroll if at bottom.
  const handleHeightChange = useCallback(() => {
    onContentChange()
  }, [onContentChange])

  // ============================================================================
  // Render
  // ============================================================================

  const hasMessages = filteredMessages.length > 0 || !!optimisticMessage
  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <div
      ref={mergedScrollRef}
      className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 min-w-0 claude-interface claude-bg"
    >
      <div className="w-full max-w-4xl mx-auto px-6 md:px-8 py-8 flex flex-col min-h-full">
        {!hasMessages ? (
          <div className="flex-1" />
        ) : (
          <>
            {/* Loading indicator for older pages */}
            {isLoadingPage && (
              <div className="flex justify-center py-4">
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--claude-text-tertiary)' }}>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Loading messages…
                </div>
              </div>
            )}

            {/* Virtualized message list */}
            {filteredMessages.length > 0 && (
              <div
                style={{
                  height: totalSize,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualItems.map((virtualItem) => {
                  const message = filteredMessages[virtualItem.index]
                  return (
                    <div
                      key={virtualItem.key}
                      ref={virtualizer.measureElement}
                      data-index={virtualItem.index}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <MessageBlock
                        message={message}
                        toolResultMap={maps.toolResultMap}
                        agentProgressMap={maps.agentProgressMap}
                        bashProgressMap={maps.bashProgressMap}
                        hookProgressMap={maps.hookProgressMap}
                        toolUseMap={maps.toolUseMap}
                        skillContentMap={maps.skillContentMap}
                        subagentMessagesMap={maps.subagentMessagesMap}
                        asyncTaskOutputMap={maps.asyncTaskOutputMap}
                        taskProgressMap={maps.taskProgressMap}
                        depth={0}
                        onHeightChange={handleHeightChange}
                      />
                    </div>
                  )
                })}
              </div>
            )}

            {/* Transient status indicator (e.g., "Compacting...") - after virtualized list */}
            {currentStatus && <TransientStatusBlock status={currentStatus} />}

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
            {showStreamingThinking && <StreamingThinking text={streamingThinking!} />}

            {/* Streaming response (progressive text as Claude generates)
              * Hide once the final assistant message is in the list to avoid duplicate content.
              * The MessageBlock's MessageContent uses parseMarkdownSync for immediate render,
              * ensuring a seamless visual transition with no flash. */}
            {showStreaming && <StreamingResponse text={streamingText!} />}

            {/* Work-in-Progress indicator */}
            {wipText && <ClaudeWIP text={wipText} turnId={turnId} />}
          </>
        )}
      </div>
    </div>
  )
}
