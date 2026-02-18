import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { MessageList } from './message-list'
import { ChatInput, type ChatInputHandle } from './chat-input'
import { TodoPanel } from './todo-panel'
import { useHideOnScroll } from '~/hooks/use-hide-on-scroll'
import { useSessionWebSocket, usePermissions, useSlashCommands, type ConnectionStatus, type InitData } from './hooks'
import type { TodoItem, UserQuestion, PermissionDecision } from '~/types/claude'
import type { PermissionMode } from './permission-mode-selector'
import {
  buildToolResultMap,
  hasToolUseResult,
  isStatusMessage,
  isToolUseBlock,
  type SessionMessage,
} from '~/lib/session-message-utils'

interface ChatInterfaceProps {
  sessionId: string
  sessionName?: string
  workingDir?: string
  onSessionNameChange?: (name: string) => void
  refreshSessions?: () => void // Called to refresh session list from backend
  initialMessage?: string // Message to send immediately on mount (for new session flow)
  onInitialMessageSent?: () => void // Called after initial message is sent
}

// Types that should not be rendered as messages
const SKIP_TYPES = ['file-history-snapshot', 'result']

/** Extract text content from a user message (for draft comparison) */
function extractUserMessageText(msg: SessionMessage): string | null {
  if (msg.type !== 'user') return null
  const message = msg.message as { content?: string | Array<{ type: string; text?: string }> } | undefined
  if (!message?.content) return null
  // User messages can have string content or array of content blocks
  if (typeof message.content === 'string') {
    return message.content
  }
  const textBlock = message.content.find((b) => b.type === 'text')
  return textBlock?.text ?? null
}

export function ChatInterface({
  sessionId,
  refreshSessions,
  initialMessage,
  onInitialMessageSent,
  workingDir: initialWorkingDir,
}: ChatInterfaceProps) {
  // ============================================================================
  // State
  // ============================================================================

  // Raw session messages - store as-is from WebSocket
  const [rawMessages, setRawMessages] = useState<SessionMessage[]>([])
  const [error, setError] = useState<string | null>(null)

  // Track if we've seen the init message - this marks the boundary between historical and live messages
  // IMPORTANT: This is the key to distinguishing historical incomplete tool_use from live control_requests
  // - Before init: messages are from historical JSONL cache
  // - After init: messages are from active Claude CLI stdout
  const [hasSeenInit, setHasSeenInit] = useState(false)

  // Optimistic user message (shown immediately before server confirms)
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null)

  // Tool state
  const [activeTodos, setActiveTodos] = useState<TodoItem[]>([])
  const [pendingQuestions, setPendingQuestions] = useState<UserQuestion[]>([])

  // Progress state - shows WIP indicator when Claude is working
  const [progressMessage, setProgressMessage] = useState<string | null>(null)

  // Streaming text - accumulates text from stream_event messages for progressive display
  const [streamingText, setStreamingText] = useState<string>('')

  // Tracks whether streaming has completed (message_stop received) but we're waiting
  // for the final assistant message to arrive and render before clearing streamingText
  const streamingCompleteRef = useRef(false)

  // Token batching for smooth streaming UX
  // Tokens are buffered and flushed every 40ms to reduce re-renders and smooth visual appearance
  const streamingBufferRef = useRef<string[]>([])
  const streamingFlushIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Permission mode state - tracks current session permission mode
  // Initialize from localStorage so newly created sessions show the correct mode
  // (the mode was already sent to the backend during session creation)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('claude-permission-mode')
      if (saved === 'default' || saved === 'acceptEdits' || saved === 'plan' || saved === 'bypassPermissions') {
        return saved
      }
    }
    return 'default'
  })

  // Working directory (read-only for existing sessions)
  const workingDir = initialWorkingDir

  // ============================================================================
  // Refs
  // ============================================================================

  // ChatInput ref for draft lifecycle management
  const chatInputRef = useRef<ChatInputHandle>(null)

  // Track if we've refreshed sessions for this session
  const hasRefreshedRef = useRef(false)
  // Track if initial message has been sent (to avoid sending twice)
  const initialMessageSentRef = useRef(false)
  // Track if initial history load is complete (avoid refresh during history replay)
  // Uses debounce: marked complete when no messages received for 500ms
  const initialLoadCompleteRef = useRef(false)
  const initialLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // State-based trigger for initial load completion (drives working state detection)
  const [initialLoadComplete, setInitialLoadComplete] = useState(false)
  // One-shot: whether we've already detected initial working state for this session
  const hasDetectedWorkingStateRef = useRef(false)
  // Track if we've connected at least once (to detect reconnections vs initial connection)
  const wasConnectedRef = useRef(false)
  // Track if permission mode has been synced to backend for this session
  const permissionModeSyncedRef = useRef(false)

  // Scroll container element for hide-on-scroll behavior
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

  // ============================================================================
  // Hooks
  // ============================================================================

  // Permission tracking hook
  const permissions = usePermissions()

  // WebSocket message handler
  const handleMessage = useCallback(
    (data: unknown) => {
      const msg = data as Record<string, unknown>

      // Debounce initial load detection: reset timer on each message
      // After 500ms of no messages, mark initial load as complete
      if (!initialLoadCompleteRef.current) {
        if (initialLoadTimerRef.current) {
          clearTimeout(initialLoadTimerRef.current)
        }
        initialLoadTimerRef.current = setTimeout(() => {
          initialLoadCompleteRef.current = true
          initialLoadTimerRef.current = null
          setInitialLoadComplete(true)
        }, 500)
      }

      // Handle error messages
      if (msg.type === 'error') {
        console.error('[ChatInterface] Error from server:', msg.error)
        setError((msg.error as string) || 'An error occurred')
        setTimeout(() => setError(null), 5000)
        return
      }

      // Handle todo updates
      if (msg.type === 'todo_update') {
        const msgData = msg.data as { todos?: TodoItem[] } | undefined
        const todos: TodoItem[] = msgData?.todos || []
        setActiveTodos(todos)
        return
      }

      // Handle progress updates
      if (msg.type === 'progress') {
        const progressData = msg.data as Record<string, unknown> | undefined
        let progressMsg: string | null = null

        if (progressData?.type === 'bash_progress') {
          const elapsed = (progressData.elapsedTimeSeconds as number) || 0
          const lines = (progressData.totalLines as number) || 0
          progressMsg = `Running command... (${elapsed}s${lines > 0 ? `, ${lines} lines` : ''})`
        } else if (progressData?.type === 'hook_progress') {
          progressMsg = (progressData.hookName as string) || 'Running hook...'
        } else if (progressData?.type === 'agent_progress') {
          const agentId = (progressData.agentId as string) || 'unknown'
          const prompt = (progressData.prompt as string) || ''
          const truncatedPrompt = prompt.length > 50 ? prompt.slice(0, 50) + '...' : prompt
          progressMsg = `Agent ${agentId}: ${truncatedPrompt || 'Working...'}`
        } else if (progressData?.type === 'query_update') {
          progressMsg = `Searching: ${(progressData.query as string) || '...'}`
        } else if (progressData?.type === 'search_results_received') {
          progressMsg = `Found ${(progressData.resultCount as number) || 0} results for: ${(progressData.query as string) || '...'}`
        } else {
          progressMsg =
            (msg.message as string) ||
            (progressData?.message as string) ||
            `Progress: ${(progressData?.type as string) || 'unknown'}`
        }

        setProgressMessage(progressMsg)
        return
      }

      // Handle stream_event messages - progressive text streaming
      if (msg.type === 'stream_event') {
        const event = msg.event as Record<string, unknown> | undefined
        if (!event) return

        const eventType = event.type as string | undefined

        // Handle text deltas from content_block_delta events
        // Buffer tokens instead of immediate state update for smoother visual appearance
        if (eventType === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown> | undefined
          if (delta?.type === 'text_delta') {
            const text = delta.text as string | undefined
            if (text) {
              streamingBufferRef.current.push(text)
            }
          }
        }

        // On message_stop: flush remaining buffer but DON'T clear streamingText yet.
        // We keep it visible until the final assistant message arrives and renders,
        // preventing a flash where content disappears between StreamingResponse unmounting
        // and MessageBlock rendering.
        if (eventType === 'message_stop') {
          // Flush any remaining buffered tokens so streamingText is complete
          if (streamingBufferRef.current.length > 0) {
            const remaining = streamingBufferRef.current.join('')
            streamingBufferRef.current = []
            setStreamingText((prev) => prev + remaining)
          }
          streamingCompleteRef.current = true
        }

        return
      }

      // Handle result messages
      if (msg.type === 'result') {
        setTurnInProgress(false)
        setProgressMessage(null)
        // Clear any stale streaming text. During historical replay, messages arrive
        // rapidly and the assistant message may clear streamingText before message_stop
        // flushes the remaining buffer — leaving orphaned streaming text that never
        // gets cleared. The result message is the definitive turn terminator, so any
        // remaining streamingText is stale.
        setStreamingText('')
        streamingBufferRef.current = []
        streamingCompleteRef.current = false
        setRawMessages((prev) => {
          const resultMsg: SessionMessage = {
            type: 'result',
            uuid: (msg.uuid as string) || crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            ...(msg as object),
          }
          const exists = prev.some((m) => m.uuid === resultMsg.uuid)
          if (exists) return prev
          return [...prev, resultMsg]
        })
        return
      }

      // Handle control_request - delegate to permissions hook
      // Special case: AskUserQuestion is handled via the standard permission protocol
      // but we show the question UI instead of the permission UI
      if (msg.type === 'control_request') {
        const request = msg.request as { subtype?: string; tool_name?: string; input?: Record<string, unknown> } | undefined
        if (request?.subtype === 'can_use_tool') {
          const requestId = msg.request_id as string
          const toolName = request.tool_name || ''

          // AskUserQuestion: show question UI instead of permission UI
          if (toolName === 'AskUserQuestion') {
            const input = request.input as { questions?: Array<{
              question: string
              header: string
              options: Array<{ label: string; description: string }>
              multiSelect: boolean
            }> } | undefined
            const questions = input?.questions

            if (requestId && questions && questions.length > 0) {
              setPendingQuestions((prev) => {
                // Deduplicate by request_id to prevent duplicate popovers on reconnection.
                // When WebSocket reconnects, the backend resends all cached messages including
                // control_requests that are already in pendingQuestions.
                if (prev.some((q) => q.id === requestId)) return prev
                return [
                  ...prev,
                  {
                    id: requestId,
                    toolCallId: requestId, // Use request_id as toolCallId for compatibility
                    questions,
                  },
                ]
              })
            }
            return
          }

          // Regular tools: show permission UI
          permissions.handleControlRequest({
            request_id: requestId,
            request: {
              tool_name: toolName,
              input: request.input,
            },
          })
        }
        return
      }

      // Handle control_response - for permission tool responses and permission mode changes
      if (msg.type === 'control_response') {
        const requestId = msg.request_id as string

        // Check if this is a set_permission_mode response
        const response = msg.response as { subtype?: string; mode?: string } | undefined
        if (response?.subtype === 'set_permission_mode' && response.mode) {
          setPermissionMode(response.mode as PermissionMode)
        }

        // Remove from pendingQuestions if this response is for an AskUserQuestion
        // (AskUserQuestion uses pendingQuestions, not pendingPermissions)
        setPendingQuestions((prev) => prev.filter((q) => q.id !== requestId))

        // Also delegate to permissions hook (for can_use_tool responses)
        permissions.handleControlResponse({
          request_id: requestId,
        })
        return
      }

      // Handle system init message
      // IMPORTANT: init is the boundary marker between historical and live messages
      // It's stdout-only (never persisted to JSONL), so seeing it means we're receiving live data
      if (msg.type === 'system' && msg.subtype === 'init') {
        setHasSeenInit(true) // Mark that we've crossed from historical to live messages
        const initMsg: SessionMessage = {
          type: 'system',
          uuid: (msg.uuid as string) || crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          ...(msg as object),
        }
        setRawMessages((prev) => {
          const exists = prev.some((m) => m.uuid === initMsg.uuid)
          if (exists) return prev
          return [initMsg, ...prev]
        })
        return
      }

      // Handle SessionMessage format
      const sessionMsg = msg as unknown as SessionMessage

      if (sessionMsg.type === 'user' && !hasToolUseResult(sessionMsg)) {
        // Synthetic user message received - check if it matches our draft
        const msgText = extractUserMessageText(sessionMsg)
        const draft = chatInputRef.current?.getDraft()
        if (draft && msgText && draft.trim() === msgText.trim()) {
          // Message confirmed sent - clear the draft from localStorage
          chatInputRef.current?.clearDraft()
        }
        setOptimisticMessage(null)
      }

      if (sessionMsg.type === 'assistant') {
        setProgressMessage(null)
        // Clear streaming text after the assistant message is added to rawMessages.
        // We use requestAnimationFrame to ensure the MessageBlock has time to render
        // with its initial sync-parsed content before StreamingResponse unmounts.
        // This prevents the flash of empty content during the transition.
        if (streamingCompleteRef.current) {
          requestAnimationFrame(() => {
            setStreamingText('')
            streamingCompleteRef.current = false
          })
        } else {
          setStreamingText('')
        }
      }

      // Refresh session list once after initial history load completes
      if (
        !hasRefreshedRef.current &&
        initialLoadCompleteRef.current &&
        refreshSessions
      ) {
        hasRefreshedRef.current = true
        refreshSessions()
      }

      setRawMessages((prev) => {
        const existingIndex = prev.findIndex((m) => m.uuid === sessionMsg.uuid)
        if (existingIndex >= 0) {
          const updated = [...prev]
          updated[existingIndex] = sessionMsg
          return updated
        }
        return [...prev, sessionMsg]
      })
    },
    // Use specific stable functions, not the whole permissions object
    // handleControlRequest and handleControlResponse have empty deps, so they're stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [permissions.handleControlRequest, permissions.handleControlResponse, refreshSessions]
  )

  // WebSocket connection hook
  const ws = useSessionWebSocket(sessionId, { onMessage: handleMessage })

  // Hide input on mobile when scrolling up
  const { shouldHide: shouldHideInput } = useHideOnScroll(scrollElement, {
    threshold: 50,
    bottomThreshold: 100,
  })

  // ============================================================================
  // Derived State
  // ============================================================================

  // Build tool result map from raw messages
  const toolResultMap = useMemo(() => buildToolResultMap(rawMessages), [rawMessages])

  // Extract init data from system:init message for slash commands
  const initData = useMemo<InitData | null>(() => {
    const initMsg = rawMessages.find(
      (m) => m.type === 'system' && (m as unknown as Record<string, unknown>).subtype === 'init'
    )
    if (!initMsg) return null
    const data = initMsg as unknown as Record<string, unknown>
    return {
      slash_commands: data.slash_commands as string[] | undefined,
      skills: data.skills as string[] | undefined,
    }
  }, [rawMessages])

  // Get merged slash commands (built-in + dynamic from init)
  const slashCommands = useSlashCommands(initData)

  // Filter messages for rendering
  const renderableMessages = useMemo(() => {
    return rawMessages.filter((msg) => {
      if (SKIP_TYPES.includes(msg.type)) return false
      if (msg.type === 'user' && hasToolUseResult(msg)) return false
      return true
    })
  }, [rawMessages])

  // Whether Claude is actively processing a turn
  // Set true when user sends a message, set false when 'result' arrives
  const [turnInProgress, setTurnInProgress] = useState(false)

  // Derive working state: either we're waiting for echo (optimistic) or a turn is in progress
  const isWorking = optimisticMessage != null || turnInProgress

  // Detect compacting state — suppress WIP "Working..." since message-block shows its own indicator
  const isCompacting = useMemo(() => {
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const msg = rawMessages[i]
      if (isStatusMessage(msg)) {
        const raw = msg as unknown as Record<string, unknown>
        return raw.status === 'compacting' || raw.content === 'compacting'
      }
      // Stop searching once we hit a non-status message
      break
    }
    return false
  }, [rawMessages])

  // Only show connection status banner after we've connected at least once
  const effectiveConnectionStatus: ConnectionStatus =
    ws.hasConnected && ws.connectionStatus !== 'connected' ? ws.connectionStatus : 'connected'

  // Detect AskUserQuestion tool_use blocks that need user response
  //
  // BOUNDARY MARKER: hasSeenInit
  // - Before init: messages are historical (from JSONL cache)
  // - After init: messages are live (from Claude CLI stdout)
  //
  // POPOVER BEHAVIOR:
  // - !hasSeenInit (historical session): Show popover for detected tool_use without result
  //   → Allows user to answer and activate the session (Case 1)
  // - hasSeenInit (live session): Only show popover for control_request questions
  //   → Historical tool_use are shown in message list as incomplete (○ gray) but no popover (Case 2)
  //   → Live control_requests show popover (Case 3)
  //
  // NOTE: Message list always renders tool_use status correctly - this only affects popover behavior
  useEffect(() => {
    // For live sessions (after init), only use control_request questions
    // These are added via the control_request handler and have sdk-perm-xxx format
    if (hasSeenInit) {
      setPendingQuestions((prev) => prev.filter((q) => q.id.startsWith('sdk-perm-')))
      return
    }

    // For historical sessions (before init), detect tool_use blocks without results
    const detectedQuestions: UserQuestion[] = []

    for (const msg of rawMessages) {
      if (msg.type !== 'assistant') continue
      const content = msg.message?.content
      if (!Array.isArray(content)) continue

      for (const block of content) {
        if (!isToolUseBlock(block)) continue
        if (block.name !== 'AskUserQuestion') continue

        // Check if this tool_use already has a result
        if (toolResultMap.has(block.id)) continue

        // Extract question data from input
        const input = block.input as {
          questions?: Array<{
            question: string
            header: string
            options: Array<{ label: string; description: string }>
            multiSelect: boolean
          }>
        }

        if (input.questions && input.questions.length > 0) {
          detectedQuestions.push({
            id: block.id,
            toolCallId: block.id,
            questions: input.questions,
          })
        }
      }
    }

    // For historical sessions, merge detected questions with any existing control_request questions
    setPendingQuestions((prev) => {
      const controlRequestQuestions = prev.filter((q) => q.id.startsWith('sdk-perm-'))
      // Deduplicate by id
      const merged = [...controlRequestQuestions]
      for (const q of detectedQuestions) {
        if (!merged.some((m) => m.id === q.id)) {
          merged.push(q)
        }
      }
      return merged
    })
  }, [rawMessages, toolResultMap, hasSeenInit])

  // ============================================================================
  // Effects
  // ============================================================================

  // Reset state when sessionId changes
  useEffect(() => {
    setRawMessages([])
    setOptimisticMessage(null)
    setTurnInProgress(false)
    setActiveTodos([])
    setError(null)
    setProgressMessage(null)
    setStreamingText('')
    streamingBufferRef.current = [] // Clear buffered tokens on session change
    streamingCompleteRef.current = false
    // Restore permission mode from localStorage (not hardcoded 'default')
    // so switching sessions preserves the user's last-used mode
    const savedMode = localStorage.getItem('claude-permission-mode')
    if (savedMode === 'default' || savedMode === 'acceptEdits' || savedMode === 'plan' || savedMode === 'bypassPermissions') {
      setPermissionMode(savedMode)
    } else {
      setPermissionMode('default')
    }
    permissions.reset()
    hasRefreshedRef.current = false
    initialLoadCompleteRef.current = false
    setInitialLoadComplete(false)
    hasDetectedWorkingStateRef.current = false
    initialMessageSentRef.current = false
    wasConnectedRef.current = false // Reset so initial connection to new session isn't treated as reconnect
    permissionModeSyncedRef.current = false // Reset so permission mode is synced to new session
    setHasSeenInit(false) // Reset init boundary marker for new session
    if (initialLoadTimerRef.current) {
      clearTimeout(initialLoadTimerRef.current)
      initialLoadTimerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- permissions.reset is stable
  }, [sessionId])

  // Cleanup initial load timer on unmount
  useEffect(() => {
    return () => {
      if (initialLoadTimerRef.current) {
        clearTimeout(initialLoadTimerRef.current)
      }
    }
  }, [])

  // Detect mid-turn state after initial message history replay completes.
  //
  // When opening a session that is currently working, turnInProgress defaults to
  // false (it's only set true by sendMessage). After the initial load finishes,
  // we can detect mid-turn from the message stream:
  //
  // 1. init message present → session has a running process (live, not historical)
  // 2. Scan backward from end: if we find a user message (non-tool-result) before
  //    finding a result message → turn started but hasn't completed → working
  //
  // This is a one-shot detection — once done, live message handlers take over
  // (sendMessage sets true, result handler sets false).
  useEffect(() => {
    if (!initialLoadComplete || hasDetectedWorkingStateRef.current) return
    hasDetectedWorkingStateRef.current = true

    // Only detect for live sessions (init = process is running)
    const hasInit = rawMessages.some(
      (m) => m.type === 'system' && (m as unknown as Record<string, unknown>).subtype === 'init'
    )
    if (!hasInit) return

    // Scan backward: if we find a user message before a result, turn is in progress
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const msg = rawMessages[i]
      if (msg.type === 'result') break // Turn completed, not working
      if (msg.type === 'user' && !hasToolUseResult(msg)) {
        setTurnInProgress(true)
        break
      }
    }
  }, [initialLoadComplete, rawMessages])

  // Token batching: flush buffer every 40ms for smooth streaming UX
  // This reduces re-renders from ~100/sec to ~25/sec while maintaining perceived responsiveness
  useEffect(() => {
    streamingFlushIntervalRef.current = setInterval(() => {
      if (streamingBufferRef.current.length > 0) {
        const bufferedText = streamingBufferRef.current.join('')
        streamingBufferRef.current = []
        setStreamingText((prev) => prev + bufferedText)
      }
    }, 40) // ~25 updates/second

    return () => {
      if (streamingFlushIntervalRef.current) {
        clearInterval(streamingFlushIntervalRef.current)
      }
    }
  }, [])

  // Track reconnection for hasConnected state
  //
  // UX REQUIREMENT: Seamless reconnection
  // - If scrolled to middle: stay at same position after reconnect
  // - If stuck to bottom: remain stuck to bottom after reconnect
  //
  // Messages are NOT cleared on reconnect - the uuid-based deduplication in handleMessage
  // ensures incoming messages either update existing ones or append new ones seamlessly.
  // This keeps the scroll position stable and avoids UI flicker.
  useEffect(() => {
    if (ws.connectionStatus === 'connected') {
      wasConnectedRef.current = true
    }
  }, [ws.connectionStatus])

  // Sync permission mode to backend on first connection
  // This ensures the backend session has the correct mode before activation,
  // especially for reopened/historical sessions where createShellSession defaults to 'default'
  useEffect(() => {
    if (ws.connectionStatus === 'connected' && !permissionModeSyncedRef.current) {
      permissionModeSyncedRef.current = true
      // Only sync if mode differs from default (avoid unnecessary activation of historical sessions)
      if (permissionMode !== 'default') {
        ws.sendMessage({
          type: 'control_request',
          request_id: `sync_permission_mode_${Date.now()}`,
          request: {
            subtype: 'set_permission_mode',
            mode: permissionMode,
          },
        }).catch((err) => {
          console.error('[ChatInterface] Failed to sync permission mode:', err)
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on first connection
  }, [ws.connectionStatus])

  // ============================================================================
  // Handlers
  // ============================================================================

  // Send message via WebSocket
  const sendMessage = useCallback(
    async (content: string) => {
      setOptimisticMessage(content)
      setTurnInProgress(true)
      // Clear stale streaming state from the previous turn immediately.
      // Without this, the old streamingText can briefly flash when the new user
      // message makes showStreaming=true (last message is no longer 'assistant')
      // before the deferred requestAnimationFrame from the previous turn's
      // assistant message handler has a chance to clear it.
      setStreamingText('')
      streamingBufferRef.current = []
      streamingCompleteRef.current = false

      try {
        await ws.sendMessage({
          type: 'user_message',
          content,
        })
      } catch (error) {
        console.error('Failed to send message:', error)
        setError('Failed to send message. Please try again.')
        setOptimisticMessage(null)
        setTurnInProgress(false)
        chatInputRef.current?.restoreDraft()
        setTimeout(() => setError(null), 3000)
      }
    },
    [ws]
  )

  // Handle permission decision
  const handlePermissionDecision = useCallback(
    async (requestId: string, decision: PermissionDecision) => {
      const response = permissions.buildPermissionResponse(requestId, decision)
      if (!response) return

      try {
        await ws.sendMessage(response)
        // Add to responses locally for immediate UI feedback
        permissions.handleControlResponse({ request_id: requestId })
      } catch (error) {
        console.error('[ChatInterface] Failed to send permission response:', error)
        // Still mark as responded locally to clear the UI
        permissions.handleControlResponse({ request_id: requestId })
      }
    },
    // Using specific stable functions to avoid unnecessary re-renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [permissions.buildPermissionResponse, permissions.handleControlResponse, ws.sendMessage]
  )

  // Handle question answer - send control_response with updated_input back to backend
  // AskUserQuestion uses the standard permission protocol with updated_input for answers
  const handleQuestionAnswer = useCallback(
    async (questionId: string, answers: Record<string, string | string[]>) => {
      try {
        // Find the pending question to get the original questions array
        const pendingQuestion = pendingQuestions.find((q) => q.id === questionId)
        if (!pendingQuestion) {
          console.error('[ChatInterface] Question not found:', questionId)
          return
        }

        // Send control_response with updated_input containing questions and answers
        await ws.sendMessage({
          type: 'control_response',
          request_id: questionId,
          response: {
            subtype: 'success',
            response: {
              behavior: 'allow',
              updated_input: {
                questions: pendingQuestion.questions,
                answers: answers,
              },
            },
          },
          tool_name: 'AskUserQuestion',
          always_allow: false,
        })
        // Remove from pending questions
        setPendingQuestions((prev) => prev.filter((q) => q.id !== questionId))
      } catch (error) {
        console.error('[ChatInterface] Failed to send question answer:', error)
        setError('Failed to send answer')
        setTimeout(() => setError(null), 3000)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.sendMessage, pendingQuestions]
  )

  // Handle question skip - send control_response with behavior=deny
  const handleQuestionSkip = useCallback(
    async (questionId: string) => {
      try {
        // Send control_response with deny behavior
        await ws.sendMessage({
          type: 'control_response',
          request_id: questionId,
          response: {
            subtype: 'success',
            response: {
              behavior: 'deny',
              message: 'User skipped this question',
            },
          },
          tool_name: 'AskUserQuestion',
          always_allow: false,
        })
        // Remove from pending questions
        setPendingQuestions((prev) => prev.filter((q) => q.id !== questionId))
      } catch (error) {
        console.error('[ChatInterface] Failed to send question skip:', error)
        setError('Failed to skip question')
        setTimeout(() => setError(null), 3000)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.sendMessage]
  )

  // Handle interrupt - stop Claude's current operation via WebSocket
  // Uses standard control_request format per docs/claude-code/data-models.md
  const handleInterrupt = useCallback(async () => {
    if (!isWorking) return

    try {
      await ws.sendMessage({
        type: 'control_request',
        request_id: `interrupt_${Date.now()}`,
        request: {
          subtype: 'interrupt',
        },
      })
    } catch (error) {
      console.error('[ChatInterface] Interrupt error:', error)
      setError('Failed to interrupt session')
      setTimeout(() => setError(null), 5000)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWorking, ws.sendMessage])

  // Handle permission mode change - send control_request to backend via WebSocket
  //
  // Permission mode behavior for existing sessions:
  // - Always sends set_permission_mode request to backend
  // - If session is inactive (historical): backend activates it with the new mode
  // - If session is active: backend sends mode change to Claude
  //
  // This is simpler than tracking inactive state in frontend - backend handles it uniformly.
  const handlePermissionModeChange = useCallback(
    async (mode: PermissionMode) => {
      // Optimistically update UI
      setPermissionMode(mode)

      // Persist to localStorage so new sessions default to the last-used mode
      localStorage.setItem('claude-permission-mode', mode)

      try {
        await ws.sendMessage({
          type: 'control_request',
          request_id: `set_permission_mode_${Date.now()}`,
          request: {
            subtype: 'set_permission_mode',
            mode,
          },
        })
      } catch (error) {
        console.error('[ChatInterface] Failed to set permission mode:', error)
        setError('Failed to change permission mode')
        setTimeout(() => setError(null), 3000)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.sendMessage]
  )

  // Send initial message once connected (for new session flow)
  useEffect(() => {
    if (
      initialMessage &&
      !initialMessageSentRef.current &&
      ws.connectionStatus === 'connected'
    ) {
      initialMessageSentRef.current = true
      sendMessage(initialMessage)
      onInitialMessageSent?.()
    }
  }, [initialMessage, ws.connectionStatus, sendMessage, onInitialMessageSent])

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="flex flex-1 flex-col min-h-0 claude-bg">
      {/* Error Banner */}
      {error && (
        <div className="bg-destructive/10 border-b border-destructive/30 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Messages */}
        <div className="flex flex-1 flex-col min-h-0 min-w-0">
          <MessageList
            messages={renderableMessages}
            toolResultMap={toolResultMap}
            optimisticMessage={optimisticMessage}
            streamingText={streamingText}
            wipText={
              isWorking && !streamingText && !isCompacting
                ? activeTodos.find((t) => t.status === 'in_progress')?.activeForm ||
                  progressMessage ||
                  'Working...'
                : null
            }
            onScrollElementReady={setScrollElement}
          />

          <ChatInput
            ref={chatInputRef}
            sessionId={sessionId}
            onSend={sendMessage}
            pendingPermissions={permissions.pendingPermissions}
            onPermissionDecision={handlePermissionDecision}
            pendingQuestions={pendingQuestions}
            onQuestionAnswer={handleQuestionAnswer}
            onQuestionSkip={handleQuestionSkip}
            hiddenOnMobile={shouldHideInput}
            isWorking={isWorking}
            onInterrupt={handleInterrupt}
            connectionStatus={effectiveConnectionStatus}
            workingDir={workingDir}
            slashCommands={slashCommands}
            permissionMode={permissionMode}
            onPermissionModeChange={handlePermissionModeChange}
          />
        </div>

        {/* Todo Panel (collapsible) */}
        {activeTodos.length > 0 && <TodoPanel todos={activeTodos} />}
      </div>
    </div>
  )
}
