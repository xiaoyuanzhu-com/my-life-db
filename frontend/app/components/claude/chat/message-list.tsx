import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useScrollController } from '~/hooks/use-scroll-controller'
import { useVirtualList } from '~/hooks/use-virtual-list'
import { useFilteredMessages } from './use-filtered-messages'
import { TransientStatusBlock } from './session-messages'
import { MessageBlock } from './message-block'
import { PreviewFullscreen } from './preview-fullscreen'
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
  /** Called when hide-on-scroll state changes (true = hidden) */
  onHideChange?: (hidden: boolean) => void
  /** Whether a page of older messages is currently being loaded */
  isLoadingPage?: boolean
  /** Whether there are more historical pages available to load */
  hasMoreHistory?: boolean
  /** Callback to load the next older page of messages */
  onLoadOlderPage?: () => void
}

/**
 * MessageList - Top-level message container with flow-based virtual scrolling
 *
 * This component handles:
 * - Virtual scrolling via useVirtualList (only visible items are in the DOM)
 * - Flow-based layout with spacer divs (no absolute positioning)
 * - CSS overflow-anchor for browser-native scroll anchoring on item resize
 * - Scroll container with unified scroll controller (sticky, hide-on-scroll, history paging)
 * - Empty state when no messages
 * - Optimistic user message display
 * - Work-in-progress indicator
 * - User-intent-driven loading for older message pages
 * - Streaming display (StreamingResponse, StreamingThinking, ClaudeWIP)
 * - TransientStatusBlock for ephemeral session status (e.g., compacting)
 *
 * The useScrollController hook handles:
 * - Sticking to bottom when new content is added
 * - Allowing user to scroll up to break sticky behavior
 * - Re-engaging sticky when user scrolls back to bottom
 * - Mobile momentum scrolling via scroll + scrollend events
 * - Phase-gated ResizeObserver (never fights user input)
 * - Hide-on-scroll for chat input (ref-based, no React re-renders during scroll)
 * - Near-top detection for history page loading
 *
 * For actual message rendering, each virtual item renders a MessageBlock directly.
 * SessionMessages is still used for nested Task tool conversations (depth > 0).
 */
export function MessageList({ messages, toolResultMap, optimisticMessage, streamingText, streamingThinking, turnId, wipText, onHideChange, isLoadingPage, hasMoreHistory, onLoadOlderPage }: MessageListProps) {
  // Filter messages and build lookup maps (same logic as SessionMessages uses for depth > 0)
  const { filteredMessages, maps, currentStatus } = useFilteredMessages(
    messages,
    toolResultMap,
    0, // depth = 0 for top-level
  )

  // ============================================================================
  // Fullscreen preview state — lifted above the virtualizer so it survives
  // item unmount/remount cycles (e.g., orientation change, scroll-based recycling)
  // ============================================================================

  const [fullscreenSrcdoc, setFullscreenSrcdoc] = useState<string | null>(null)
  const handleRequestFullscreen = useCallback((srcdoc: string) => setFullscreenSrcdoc(srcdoc), [])
  const handleCloseFullscreen = useCallback(() => setFullscreenSrcdoc(null), [])

  // ============================================================================
  // Scroll controller + virtual list
  // ============================================================================

  const nearTopHandlerRef = useRef<(() => void) | undefined>(undefined)
  const stableNearTop = useCallback(() => nearTopHandlerRef.current?.(), [])

  const { scrollRef, contentRef, scrollElement, contentElement, shouldStick, userScrollIntent } = useScrollController({
    onHideChange,
    onNearTop: stableNearTop,
  })

  const historyPagingActiveRef = useRef(false)

  const getKey = useCallback(
    (index: number) => filteredMessages[index]?.uuid ?? index,
    [filteredMessages],
  )

  const { startIndex, endIndex, topHeight, bottomHeight } = useVirtualList({
    count: filteredMessages.length,
    estimateSize: 120,
    overscanPx: 5400,
    scrollElement,
    contentElement,
    getKey,
    shouldStick,
    userScrollIntent,
  })

  // Set the near-top handler (updated each render) — simplified since browser
  // scroll anchoring handles position preservation on prepend.
  nearTopHandlerRef.current = () => {
    if (!onLoadOlderPage || !hasMoreHistory || isLoadingPage) return
    historyPagingActiveRef.current = true
    onLoadOlderPage()
  }

  // ============================================================================
  // Continued history paging while user remains near the top
  // ============================================================================

  // Keep loading progressively only after the user has deliberately scrolled to
  // the history boundary. This preserves the old "keep pulling history while I
  // stay at the top" behavior without letting a bad initial scroll position
  // trigger background overfetch on first open.
  useEffect(() => {
    const element = scrollElement.current
    if (!element || !historyPagingActiveRef.current || isLoadingPage) return

    if (!hasMoreHistory || shouldStick.current || element.scrollTop >= 1000) {
      historyPagingActiveRef.current = false
      return
    }

    nearTopHandlerRef.current?.()
  }, [filteredMessages.length, isLoadingPage, hasMoreHistory, shouldStick, scrollElement])

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
  // Render
  // ============================================================================

  const hasMessages = filteredMessages.length > 0 || !!optimisticMessage

  return (
    <>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 min-w-0 claude-interface claude-bg"
        style={{ touchAction: 'pan-y' }}
      >
        <div ref={contentRef} className="w-full max-w-4xl mx-auto px-6 md:px-8 py-8 flex flex-col min-h-full">
          {!hasMessages ? (
            <div className="flex-1" />
          ) : (
            <>
              {/* Loading indicator for older pages — not an anchor candidate */}
              {isLoadingPage && (
                <div className="flex justify-center py-4" style={{ overflowAnchor: 'none' }}>
                  <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--claude-text-tertiary)' }}>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Loading messages…
                  </div>
                </div>
              )}

              {/* Flow-based virtual message list */}
              {filteredMessages.length > 0 && (
                <>
                  {/* Top spacer — estimated height of items above the render window.
                    * overflow-anchor: none prevents browser from anchoring on a spacer. */}
                  <div style={{ height: topHeight, overflowAnchor: 'none' }} />

                  {/* Rendered items — normal document flow, valid anchor candidates.
                    * Browser overflow-anchor: auto (default) keeps these visually stable
                    * when content above or below them changes size. */}
                  {Array.from({ length: endIndex - startIndex }, (_, i) => {
                    const index = startIndex + i
                    const message = filteredMessages[index]
                    if (!message) return null
                    return (
                      <div key={message.uuid} data-vi={index} className="min-w-0">
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
                          onRequestFullscreen={handleRequestFullscreen}
                        />
                      </div>
                    )
                  })}

                  {/* Bottom spacer — estimated height of items below the render window. */}
                  <div style={{ height: bottomHeight, overflowAnchor: 'none' }} />
                </>
              )}

              {/* Transient status indicator (e.g., "Compacting...") — not an anchor candidate */}
              {currentStatus && (
                <div style={{ overflowAnchor: 'none' }}>
                  <TransientStatusBlock status={currentStatus} />
                </div>
              )}

              {/* Optimistic user message (shown before server confirms) — not an anchor candidate */}
              {optimisticMessage && (
                <div className="mb-4" style={{ overflowAnchor: 'none' }}>
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

              {/* Streaming thinking — not an anchor candidate (changes constantly) */}
              {showStreamingThinking && (
                <div style={{ overflowAnchor: 'none' }}>
                  <StreamingThinking text={streamingThinking!} />
                </div>
              )}

              {/* Streaming response — not an anchor candidate (changes constantly) */}
              {showStreaming && (
                <div style={{ overflowAnchor: 'none' }}>
                  <StreamingResponse text={streamingText!} />
                </div>
              )}

              {/* Work-in-Progress indicator — not an anchor candidate */}
              {wipText && (
                <div style={{ overflowAnchor: 'none' }}>
                  <ClaudeWIP text={wipText} turnId={turnId} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Fullscreen preview — rendered outside the virtual list so it survives
        * item unmount/remount cycles triggered by orientation changes or scroll. */}
      {fullscreenSrcdoc && (
        <PreviewFullscreen
          srcdoc={fullscreenSrcdoc}
          onClose={handleCloseFullscreen}
        />
      )}
    </>
  )
}
