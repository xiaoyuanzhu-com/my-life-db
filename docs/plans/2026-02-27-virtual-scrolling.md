# Virtual Scrolling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the "render everything" message list with `@tanstack/react-virtual` so only visible messages exist in the DOM, fixing iOS WebView process crashes from unbounded DOM growth.

**Architecture:** The virtualizer lives in `message-list.tsx` (owns the scroll container). One virtual item = one top-level message. Nested Task tool messages are part of their parent item's measured height, not separately virtualized. `use-stick-to-bottom` is replaced with a custom stick-to-bottom built on the virtualizer's scroll API.

**Tech Stack:** `@tanstack/react-virtual` (headless virtualizer), React 19, existing CSS grid collapsible system.

**Design doc:** `docs/plans/2026-02-27-virtual-scrolling-design.md`

---

### Task 1: Install `@tanstack/react-virtual`

**Files:**
- Modify: `frontend/package.json`

**Step 1: Install the dependency**

Run: `cd frontend && npm install @tanstack/react-virtual`

**Step 2: Verify installation**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -5`
Expected: No new type errors from the install.

**Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "feat: add @tanstack/react-virtual for message list virtualization"
```

---

### Task 2: Create `useStickToBottom` hook

The current `use-stick-to-bottom` library needs to be replaced with a hook that integrates with the virtualizer's scroll model. Build this as a standalone hook first, before touching `message-list.tsx`.

**Files:**
- Create: `frontend/app/hooks/use-stick-to-bottom.ts`

**Step 1: Write the hook**

```tsx
import { useCallback, useRef, useEffect } from 'react'

interface UseStickToBottomOptions {
  /** Pixel threshold from bottom to consider "at bottom" (default: 50) */
  threshold?: number
}

interface UseStickToBottomReturn {
  /** Whether the user is currently scrolled to the bottom */
  isAtBottom: React.RefObject<boolean>
  /** Call this to scroll to the bottom */
  scrollToBottom: (behavior?: ScrollBehavior) => void
  /** Attach to the scroll container element */
  setScrollElement: (el: HTMLDivElement | null) => void
  /** Call when content changes while at bottom (triggers auto-scroll) */
  onContentChange: () => void
}

/**
 * Custom stick-to-bottom hook that replaces the `use-stick-to-bottom` library.
 * Designed to work with @tanstack/react-virtual's scroll model.
 *
 * Behavior:
 * - Tracks whether user is scrolled to bottom (within threshold)
 * - When at bottom, auto-scrolls on content changes (new messages, streaming)
 * - User scrolling up disengages; scrolling back to bottom re-engages
 * - Mobile momentum scroll fix: also checks on `scrollend` event
 */
export function useStickToBottom(
  options: UseStickToBottomOptions = {}
): UseStickToBottomReturn {
  const { threshold = 50 } = options
  const scrollElRef = useRef<HTMLDivElement | null>(null)
  const isAtBottom = useRef(true)

  const checkIsAtBottom = useCallback(() => {
    const el = scrollElRef.current
    if (!el) return
    const { scrollTop, scrollHeight, clientHeight } = el
    isAtBottom.current = scrollHeight - scrollTop - clientHeight <= threshold
  }, [threshold])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollElRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    isAtBottom.current = true
  }, [])

  const onContentChange = useCallback(() => {
    if (isAtBottom.current) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        scrollToBottom('smooth')
      })
    }
  }, [scrollToBottom])

  const setScrollElement = useCallback(
    (el: HTMLDivElement | null) => {
      // Clean up old listeners
      const prev = scrollElRef.current
      if (prev) {
        prev.removeEventListener('scroll', checkIsAtBottom)
        prev.removeEventListener('scrollend', checkIsAtBottom)
      }
      scrollElRef.current = el
      if (el) {
        el.addEventListener('scroll', checkIsAtBottom, { passive: true })
        el.addEventListener('scrollend', checkIsAtBottom, { passive: true })
        // Initial check
        checkIsAtBottom()
      }
    },
    [checkIsAtBottom]
  )

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const el = scrollElRef.current
      if (el) {
        el.removeEventListener('scroll', checkIsAtBottom)
        el.removeEventListener('scrollend', checkIsAtBottom)
      }
    }
  }, [checkIsAtBottom])

  return { isAtBottom, scrollToBottom, setScrollElement, onContentChange }
}
```

**Step 2: Verify types compile**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -5`
Expected: No errors.

**Step 3: Commit**

```bash
git add frontend/app/hooks/use-stick-to-bottom.ts
git commit -m "feat: add custom useStickToBottom hook for virtualizer integration"
```

---

### Task 3: Rewrite `message-list.tsx` with virtualizer

This is the core change. Replace the current flat DOM render with `useVirtualizer`.

**Files:**
- Modify: `frontend/app/components/claude/chat/message-list.tsx`

**Step 1: Rewrite message-list.tsx**

Replace the entire file. Key changes:
- Import `useVirtualizer` from `@tanstack/react-virtual`
- Import the new `useStickToBottom` hook instead of the library
- The scroll container div gets `ref={scrollRef}` (for virtualizer's `getScrollElement`)
- Inside the scroll container: a spacer div with `height: virtualizer.getTotalSize()`
- Only `virtualizer.getVirtualItems()` are rendered, each wrapped in a positioned div
- `SessionMessages` is no longer called directly — `MessageBlock` is rendered per virtual item
- The maps (`toolResultMap`, etc.) must still be built — extract `SessionMessages`' filtering + map-building into a separate hook or compute it in `MessageList`
- Stick-to-bottom uses the new hook
- Scroll-up pagination uses virtualizer range detection
- Scroll position preservation on prepend uses `useLayoutEffect` + virtualizer offset adjustment

```tsx
import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFilteredMessages } from './use-filtered-messages'
import { MessageBlock } from './message-block'
import { ClaudeWIP } from './claude-wip'
import { StreamingResponse } from './streaming-response'
import { StreamingThinking } from './streaming-thinking'
import { isTextBlock } from '~/lib/session-message-utils'
import { useStickToBottom } from '~/hooks/use-stick-to-bottom'
import type { SessionMessage, ExtractedToolResult, ContentBlock } from '~/lib/session-message-utils'

interface MessageListProps {
  messages: SessionMessage[]
  toolResultMap: Map<string, ExtractedToolResult>
  optimisticMessage?: string | null
  streamingText?: string
  streamingThinking?: string
  turnId?: number
  wipText?: string | null
  onScrollElementReady?: (element: HTMLDivElement | null) => void
  isLoadingPage?: boolean
  hasMoreHistory?: boolean
  onLoadOlderPage?: () => void
}

export function MessageList({
  messages,
  toolResultMap,
  optimisticMessage,
  streamingText,
  streamingThinking,
  turnId,
  wipText,
  onScrollElementReady,
  isLoadingPage,
  hasMoreHistory,
  onLoadOlderPage,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Filter messages and build maps (extracted from SessionMessages)
  const { filteredMessages, maps, currentStatus } = useFilteredMessages(messages, toolResultMap)

  // Custom stick-to-bottom (replaces use-stick-to-bottom library)
  const { isAtBottom, scrollToBottom, setScrollElement, onContentChange } =
    useStickToBottom({ threshold: 50 })

  // Merge scroll refs
  const mergedScrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      ;(scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = element
      setScrollElement(element)
      onScrollElementReady?.(element)
    },
    [setScrollElement, onScrollElementReady]
  )

  // --- Virtualizer ---
  const virtualizer = useVirtualizer({
    count: filteredMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 5,
    // Use message UUID as stable key so virtualizer can track items across prepends
    getItemKey: (index) => filteredMessages[index].uuid,
  })

  // --- Stick-to-bottom on new messages / streaming ---
  const prevMessageCount = useRef(filteredMessages.length)

  useEffect(() => {
    const count = filteredMessages.length
    if (count > prevMessageCount.current) {
      // New messages appended
      onContentChange()
    }
    prevMessageCount.current = count
  }, [filteredMessages.length, onContentChange])

  // Auto-scroll on streaming text changes
  useEffect(() => {
    if (streamingText || streamingThinking) {
      onContentChange()
    }
  }, [streamingText, streamingThinking, onContentChange])

  // --- Scroll-up pagination ---
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const handleScroll = () => {
      if (el.scrollTop < 300 && hasMoreHistory && !isLoadingPage) {
        onLoadOlderPage?.()
      }
    }

    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [hasMoreHistory, isLoadingPage, onLoadOlderPage])

  // --- Scroll position preservation on prepend ---
  const prevPrependCountRef = useRef(filteredMessages.length)
  const prevScrollHeightRef = useRef(0)
  const prevScrollTopRef = useRef(0)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const prevCount = prevPrependCountRef.current
    const currentCount = filteredMessages.length

    if (currentCount > prevCount && prevScrollHeightRef.current > 0) {
      const heightDelta = el.scrollHeight - prevScrollHeightRef.current
      if (heightDelta > 0 && prevScrollTopRef.current < 300) {
        el.scrollTop = prevScrollTopRef.current + heightDelta
      }
    }

    prevPrependCountRef.current = currentCount
    prevScrollHeightRef.current = el.scrollHeight
    prevScrollTopRef.current = el.scrollTop
  }, [filteredMessages.length])

  // --- Adaptive viewport fill ---
  useEffect(() => {
    const el = scrollRef.current
    if (!el || isLoadingPage || !hasMoreHistory || filteredMessages.length === 0) return

    const rafId = requestAnimationFrame(() => {
      if (el.scrollHeight <= el.clientHeight || el.scrollTop < 300) {
        onLoadOlderPage?.()
      }
    })
    return () => cancelAnimationFrame(rafId)
  }, [filteredMessages.length, isLoadingPage, hasMoreHistory, onLoadOlderPage])

  // --- Streaming visibility logic (unchanged from original) ---
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

  // Callback for collapsible sections to trigger re-measurement
  const handleHeightChange = useCallback(
    (index: number) => {
      virtualizer.resizeItem(index, (entry) => entry.getBoundingClientRect().height)
    },
    [virtualizer]
  )

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div
      ref={mergedScrollRef}
      className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 min-w-0 claude-interface claude-bg"
    >
      <div className="w-full max-w-4xl mx-auto px-6 md:px-8 py-8 flex flex-col min-h-full">
        {filteredMessages.length === 0 && !optimisticMessage ? (
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
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualItems.map((virtualItem) => {
                const message = filteredMessages[virtualItem.index]
                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
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
                      onHeightChange={() => handleHeightChange(virtualItem.index)}
                    />
                  </div>
                )
              })}
            </div>

            {/* Transient status indicator */}
            {currentStatus && (
              <div className="mb-4 flex items-start gap-2">
                {/* TransientStatusBlock rendered inline — moved from session-messages */}
              </div>
            )}

            {/* Optimistic user message */}
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

            {showStreamingThinking && <StreamingThinking text={streamingThinking} />}
            {showStreaming && <StreamingResponse text={streamingText} />}
            {wipText && <ClaudeWIP text={wipText} turnId={turnId} />}
          </>
        )}
      </div>
    </div>
  )
}
```

**NOTE:** The `handleHeightChange` callback above uses `virtualizer.resizeItem`. The actual TanStack API may use `virtualizer.measure()` or re-measuring via the `measureElement` ref. Check the API docs during implementation — the key is that after a collapsible section transitions, we re-measure the affected item. If `resizeItem` doesn't exist, the correct approach is to call `virtualizer.measure()` to invalidate all measurements, or simply ensure `measureElement` is attached as a `ref` to the item wrapper (which it already is via `ref={virtualizer.measureElement}`), and the virtualizer will auto-remeasure via ResizeObserver. **Verify which approach works during Task 3.**

**Step 2: Verify it compiles**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: Errors about missing `useFilteredMessages` and `onHeightChange` prop — those are created in Tasks 4 and 5.

**Step 3: Commit (WIP)**

```bash
git add frontend/app/components/claude/chat/message-list.tsx
git commit -m "feat(wip): rewrite message-list with @tanstack/react-virtual virtualizer"
```

---

### Task 4: Extract `useFilteredMessages` hook from `SessionMessages`

`SessionMessages` currently owns both message filtering and map building. The virtualizer needs these computed values in `MessageList` (one level up). Extract the filtering + map-building into a reusable hook.

**Files:**
- Create: `frontend/app/components/claude/chat/use-filtered-messages.ts`
- Modify: `frontend/app/components/claude/chat/session-messages.tsx` — use the new hook internally

**Step 1: Create the hook**

Extract from `session-messages.tsx` lines 569-724 into a hook. The hook takes `messages` and optional pre-built maps, returns `{ filteredMessages, maps, currentStatus }`.

```tsx
import { useMemo } from 'react'
import {
  buildToolResultMap,
  isSkippedUserMessage,
  isHookResponseMessage,
  isHookStartedMessage,
  isStatusMessage,
  isTaskStartedMessage,
  isTaskProgressMessage,
  isSystemInitMessage,
  isSubagentMessage,
  type SessionMessage,
  type ExtractedToolResult,
  type TaskToolResult,
} from '~/lib/session-message-utils'
import {
  buildAgentProgressMap,
  buildBashProgressMap,
  buildHookProgressMap,
  buildToolUseMap,
  buildSkillContentMap,
  buildSubagentMessagesMap,
  buildAsyncTaskOutputMap,
  buildTaskProgressMap,
  type AgentProgressMessage,
  type BashProgressMessage,
  type HookProgressMessage,
  type TaskProgressMessage,
  type ToolUseInfo,
  type StatusMessage,
} from './session-messages'

export interface MessageMaps {
  toolResultMap: Map<string, ExtractedToolResult>
  agentProgressMap: Map<string, AgentProgressMessage[]>
  bashProgressMap: Map<string, BashProgressMessage[]>
  hookProgressMap: Map<string, HookProgressMessage[]>
  toolUseMap: Map<string, ToolUseInfo>
  skillContentMap: Map<string, string>
  subagentMessagesMap: Map<string, SessionMessage[]>
  asyncTaskOutputMap: Map<string, TaskToolResult>
  taskProgressMap: Map<string, TaskProgressMessage>
}

interface UseFilteredMessagesResult {
  filteredMessages: SessionMessage[]
  maps: MessageMaps
  currentStatus: string | null
}

/**
 * Extracts message filtering and map-building from SessionMessages.
 * Used by MessageList for the virtualizer, and by SessionMessages for nested rendering.
 *
 * @param messages - Raw messages to filter
 * @param providedToolResultMap - Pre-built tool result map (from ChatInterface)
 * @param depth - Nesting depth (0 = top-level, affects subagent filtering)
 */
export function useFilteredMessages(
  messages: SessionMessage[],
  providedToolResultMap?: Map<string, ExtractedToolResult>,
  depth = 0
): UseFilteredMessagesResult {
  // Build all maps (same logic as SessionMessages lines 569-626)
  const toolResultMap = useMemo(() => {
    if (providedToolResultMap) return providedToolResultMap
    return buildToolResultMap(messages)
  }, [messages, providedToolResultMap])

  const agentProgressMap = useMemo(() => buildAgentProgressMap(messages), [messages])
  const bashProgressMap = useMemo(() => buildBashProgressMap(messages), [messages])
  const hookProgressMap = useMemo(() => buildHookProgressMap(messages), [messages])
  const toolUseMap = useMemo(() => buildToolUseMap(messages), [messages])
  const skillContentMap = useMemo(() => buildSkillContentMap(messages), [messages])
  const subagentMessagesMap = useMemo(() => buildSubagentMessagesMap(messages), [messages])
  const asyncTaskOutputMap = useMemo(
    () => buildAsyncTaskOutputMap(messages, toolResultMap).resultMap,
    [messages, toolResultMap]
  )
  const taskProgressMap = useMemo(() => buildTaskProgressMap(messages), [messages])

  // Filter messages (same logic as SessionMessages lines 637-709)
  const filteredMessages = useMemo(() => {
    return messages.filter((msg) => {
      if (msg.type === 'progress') return false
      if (isHookStartedMessage(msg)) return false
      if (isHookResponseMessage(msg)) return false
      if (isStatusMessage(msg)) return false
      if (isTaskStartedMessage(msg)) return false
      if (isTaskProgressMessage(msg)) return false
      if (isSystemInitMessage(msg)) return false
      if (msg.type === 'control_request' || msg.type === 'control_response' || msg.type === 'control_cancel_request') return false
      if (msg.type === 'queue-operation' || msg.type === 'file-history-snapshot') return false
      if (msg.type === 'result') return false
      if (msg.type === 'stream_event') return false
      if (msg.isMeta) return false
      if (isSkippedUserMessage(msg)) return false
      if (depth === 0 && isSubagentMessage(msg)) return false
      return true
    })
  }, [messages, depth])

  // Derive current status
  const currentStatus = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as StatusMessage
      if (isStatusMessage(msg)) {
        return msg.status
      }
    }
    return null
  }, [messages])

  const maps: MessageMaps = useMemo(
    () => ({
      toolResultMap,
      agentProgressMap,
      bashProgressMap,
      hookProgressMap,
      toolUseMap,
      skillContentMap,
      subagentMessagesMap,
      asyncTaskOutputMap,
      taskProgressMap,
    }),
    [toolResultMap, agentProgressMap, bashProgressMap, hookProgressMap, toolUseMap, skillContentMap, subagentMessagesMap, asyncTaskOutputMap, taskProgressMap]
  )

  return { filteredMessages, maps, currentStatus }
}
```

**Step 2: Update `session-messages.tsx` to use the hook**

Replace the inline `useMemo` calls (lines 569-709) with the new hook. `SessionMessages` becomes a thin wrapper:

```tsx
export function SessionMessages({ messages, toolResultMap: providedToolResultMap, depth = 0, ...props }: SessionMessagesProps) {
  const { filteredMessages, maps, currentStatus } = useFilteredMessages(messages, providedToolResultMap, depth)

  if (filteredMessages.length === 0 && !currentStatus) return null

  return (
    <div className={depth > 0 ? 'nested-session' : undefined}>
      {filteredMessages.map((message) => (
        <MessageBlock
          key={message.uuid}
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
          depth={depth}
        />
      ))}
      {currentStatus && <TransientStatusBlock status={currentStatus} />}
    </div>
  )
}
```

**Important:** `SessionMessages` still exists and still renders all messages (no virtualization). It's used by nested Task tool conversations at `depth > 0`. Only `MessageList` (depth 0, top-level) virtualizes.

**Step 3: Verify it compiles**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: May still have errors about `onHeightChange` prop (Task 5).

**Step 4: Commit**

```bash
git add frontend/app/components/claude/chat/use-filtered-messages.ts frontend/app/components/claude/chat/session-messages.tsx
git commit -m "refactor: extract useFilteredMessages hook from SessionMessages"
```

---

### Task 5: Add `onHeightChange` callback to `MessageBlock` and collapsible components

When a collapsible section expands/collapses, the virtualizer needs to re-measure that item. Thread an `onHeightChange` callback from `MessageList` → `MessageBlock` → collapsible children.

**Files:**
- Modify: `frontend/app/components/claude/chat/message-block.tsx` — add `onHeightChange?: () => void` to props, pass to child tools
- Modify: `frontend/app/components/claude/chat/tools/task-tool.tsx` — accept and call `onHeightChange` on expand/collapse
- Modify: `frontend/app/components/claude/chat/tools/bash-tool.tsx` — same pattern
- Modify: `frontend/app/components/claude/chat/tools/web-fetch-tool.tsx` — same pattern
- Modify: `frontend/app/components/claude/chat/tools/web-search-tool.tsx` — same pattern
- Modify: `frontend/app/components/claude/chat/tools/skill-tool.tsx` — same pattern
- Modify: `frontend/app/components/claude/chat/tool-block.tsx` — thread `onHeightChange` to tool views

**Step 1: Add `onHeightChange` to `MessageBlockProps`**

In `message-block.tsx`, add to the interface (line 42):
```tsx
interface MessageBlockProps {
  // ... existing props ...
  /** Callback when content height changes (for virtualizer re-measurement) */
  onHeightChange?: () => void
}
```

Add to the destructured props (line 65):
```tsx
export function MessageBlock({ ..., onHeightChange }: MessageBlockProps) {
```

**Step 2: Call `onHeightChange` after collapsible transitions in `message-block.tsx`**

Everywhere a `collapsible-grid` toggles (thinking blocks ~line 417, compact summary ~line 620, tool detail ~line 1079), add a `transitionend` handler:

```tsx
<div
  className={`collapsible-grid ${isExpanded ? '' : 'collapsed'}`}
  onTransitionEnd={() => onHeightChange?.()}
>
```

**Step 3: Thread `onHeightChange` through `ToolBlock` to tool views**

In `tool-block.tsx`, add `onHeightChange` prop and pass it to each tool component. In each tool file (`task-tool.tsx`, `bash-tool.tsx`, `web-fetch-tool.tsx`, `web-search-tool.tsx`, `skill-tool.tsx`), add the prop to their interfaces and add `onTransitionEnd={() => onHeightChange?.()}` to their `collapsible-grid` divs.

**Step 4: Verify it compiles**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

**Step 5: Commit**

```bash
git add frontend/app/components/claude/chat/message-block.tsx \
       frontend/app/components/claude/chat/tool-block.tsx \
       frontend/app/components/claude/chat/tools/task-tool.tsx \
       frontend/app/components/claude/chat/tools/bash-tool.tsx \
       frontend/app/components/claude/chat/tools/web-fetch-tool.tsx \
       frontend/app/components/claude/chat/tools/web-search-tool.tsx \
       frontend/app/components/claude/chat/tools/skill-tool.tsx
git commit -m "feat: add onHeightChange callback to collapsible components for virtualizer"
```

---

### Task 6: Update `chat-interface.tsx` imports

`ChatInterface` currently imports `MessageList` which internally used `SessionMessages`. Since `MessageList` now imports `MessageBlock` directly and uses `useFilteredMessages`, the import path is unchanged. But verify nothing broke in the wiring.

**Files:**
- Modify (if needed): `frontend/app/components/claude/chat/chat-interface.tsx`

**Step 1: Verify the `MessageList` call site still works**

The call at line 1049 passes:
```tsx
<MessageList
  messages={renderableMessages}
  toolResultMap={toolResultMap}
  optimisticMessage={optimisticMessage}
  streamingText={streamingText}
  streamingThinking={streamingThinking}
  turnId={turnId}
  isLoadingPage={isLoadingHistory}
  hasMoreHistory={hasMoreHistory}
  onLoadOlderPage={loadOlderMessages}
  wipText={...}
/>
```

These props should all still match `MessageListProps`. Verify.

**Step 2: Full typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors.

**Step 3: Commit (if changes needed)**

```bash
git add frontend/app/components/claude/chat/chat-interface.tsx
git commit -m "fix: update chat-interface for new MessageList API"
```

---

### Task 7: Remove `use-stick-to-bottom` dependency

Now that the library is no longer imported anywhere, remove it.

**Files:**
- Modify: `frontend/package.json`

**Step 1: Verify no imports remain**

Run: `grep -r "use-stick-to-bottom" frontend/app/`
Expected: No results.

**Step 2: Uninstall**

Run: `cd frontend && npm uninstall use-stick-to-bottom`

**Step 3: Verify build**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "chore: remove use-stick-to-bottom dependency (replaced by custom hook + virtualizer)"
```

---

### Task 8: Build and manual verification

**Step 1: Full build**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no errors.

**Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors.

**Step 3: Lint**

Run: `cd frontend && npm run lint`
Expected: No new lint errors.

**Step 4: Manual smoke test checklist**

Test in browser (and ideally iOS Safari / WKWebView):

1. **Empty session** — Shows empty state, no errors
2. **Short session (<20 messages)** — All messages visible, stick-to-bottom works
3. **Long session (100+ messages)** — Only ~15-25 DOM nodes in the message area (inspect with DevTools)
4. **Streaming** — New text appears smoothly, auto-scrolls when at bottom
5. **Scroll up** — Disengages sticky, loads older page when near top
6. **Scroll position on prepend** — Loading older page doesn't jump viewport
7. **Scroll back to bottom** — Re-engages sticky
8. **Expand/collapse thinking** — Content expands, no layout jump
9. **Expand/collapse tool result** — Same
10. **Task tool nested conversation** — Expands inline, parent message grows, no layout issues
11. **Fast scroll** — No visible pop-in / blank areas (overscan buffer works)

**Step 5: Commit (final)**

```bash
git add -A
git commit -m "feat: virtual scrolling for session message list

Replaces render-all-to-DOM with @tanstack/react-virtual. Only visible
messages plus overscan buffer exist in the DOM at any time.

Fixes iOS WebView process crashes from unbounded DOM growth in long sessions."
```

---

### Task 9: Overscan and performance tuning (post-merge)

After merging and testing on real iOS devices:

1. **Adjust `overscan`** — Start at 5, increase to 8-10 if fast scrolling shows blank areas
2. **Adjust `estimateSize`** — If most messages are shorter/taller than 120px, update the estimate for smoother initial layout
3. **Measure on device** — Use Safari Web Inspector → Memory to verify DOM node count dropped and memory stays bounded
4. **Streaming performance** — If streaming causes jank from frequent re-measurement, debounce the `onContentChange` call to 50-100ms during active streaming

No commit for this task — it's iterative tuning.
