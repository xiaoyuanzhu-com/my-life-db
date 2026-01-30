import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { MessageList } from './message-list'
import { ChatInput, type ChatInputHandle } from './chat-input'
import { TodoPanel } from './todo-panel'
import { useHideOnScroll } from '~/hooks/use-hide-on-scroll'
import { useSessionWebSocket, usePermissions, useSlashCommands, type ConnectionStatus, type InitData } from './hooks'
import type { TodoItem, UserQuestion, PermissionDecision } from '~/types/claude'
import {
  buildToolResultMap,
  hasToolUseResult,
  isToolUseBlock,
  type SessionMessage,
} from '~/lib/session-message-utils'

interface ChatInterfaceProps {
  sessionId: string
  sessionName?: string
  workingDir?: string
  isActive?: boolean // Whether session has a running CLI process
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
  isActive,
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

  // Optimistic user message (shown immediately before server confirms)
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null)

  // Tool state
  const [activeTodos, setActiveTodos] = useState<TodoItem[]>([])
  const [pendingQuestions, setPendingQuestions] = useState<UserQuestion[]>([])

  // Progress state - shows WIP indicator when Claude is working
  const [progressMessage, setProgressMessage] = useState<string | null>(null)

  // Working directory (read-only for existing sessions)
  const workingDir = initialWorkingDir

  // ============================================================================
  // Refs
  // ============================================================================

  // ChatInput ref for draft lifecycle management
  const chatInputRef = useRef<ChatInputHandle>(null)

  // Track if we've refreshed sessions for this inactive session
  const hasRefreshedRef = useRef(false)
  // Track if initial message has been sent (to avoid sending twice)
  const initialMessageSentRef = useRef(false)
  // Keep isActive in a ref so message handler can access latest value
  const isActiveRef = useRef(isActive)
  // Track if initial history load is complete (avoid refresh during history replay)
  // Uses debounce: marked complete when no messages received for 500ms
  const initialLoadCompleteRef = useRef(false)
  const initialLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track if we've connected at least once (to detect reconnections vs initial connection)
  const wasConnectedRef = useRef(false)

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

      // Handle result messages
      if (msg.type === 'result') {
        setProgressMessage(null)
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
      if (msg.type === 'control_request') {
        const request = msg.request as { subtype?: string; tool_name?: string; input?: Record<string, unknown> } | undefined
        if (request?.subtype === 'can_use_tool') {
          permissions.handleControlRequest({
            request_id: msg.request_id as string,
            request: {
              tool_name: request.tool_name || '',
              input: request.input,
            },
          })
        }
        return
      }

      // Handle control_response - delegate to permissions hook
      if (msg.type === 'control_response') {
        permissions.handleControlResponse({
          request_id: msg.request_id as string,
        })
        return
      }

      // Handle system init message
      if (msg.type === 'system' && msg.subtype === 'init') {
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
      }

      // Only refresh if: inactive session, haven't refreshed yet, AND initial load is complete
      // This avoids refreshing during history replay when clicking on a historical session
      if (
        isActiveRef.current === false &&
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

  // Derive working state from message history and session active state
  // Rule: working = a turn is in progress (started but not completed)
  // - Turn starts when user sends a real message (not tool_result)
  // - Turn ends when 'result' message received
  const isWorking = useMemo(() => {
    if (isActive === false) return false
    if (optimisticMessage) return true

    // Has a turn started? (real user message exists, not tool_result)
    const hasStartedTurn = rawMessages.some(
      (m) => m.type === 'user' && !hasToolUseResult(m)
    )
    if (!hasStartedTurn) return false // No turn started = not working

    // Turn started, check if complete
    const lastMsg = rawMessages[rawMessages.length - 1]
    return lastMsg?.type !== 'result'
  }, [rawMessages, optimisticMessage, isActive])

  // Only show connection status banner after we've connected at least once
  const effectiveConnectionStatus: ConnectionStatus =
    ws.hasConnected && ws.connectionStatus !== 'connected' ? ws.connectionStatus : 'connected'

  // Detect AskUserQuestion tool_use blocks that need user response
  // These are tool_use blocks from assistant messages where:
  // 1. name === 'AskUserQuestion'
  // 2. No corresponding tool_result exists yet
  useEffect(() => {
    const questions: UserQuestion[] = []

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
          questions.push({
            id: block.id,
            toolCallId: block.id,
            questions: input.questions,
          })
        }
      }
    }

    setPendingQuestions(questions)
  }, [rawMessages, toolResultMap])

  // ============================================================================
  // Effects
  // ============================================================================

  // Keep isActiveRef in sync
  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  // Reset state when sessionId changes
  useEffect(() => {
    setRawMessages([])
    setOptimisticMessage(null)
    setActiveTodos([])
    setError(null)
    setProgressMessage(null)
    permissions.reset()
    hasRefreshedRef.current = false
    initialLoadCompleteRef.current = false
    initialMessageSentRef.current = false
    wasConnectedRef.current = false // Reset so initial connection to new session isn't treated as reconnect
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

  // Clear rawMessages on WebSocket reconnection to avoid duplicates
  // When the server restarts, the client reconnects and the server resends all cached messages.
  // Without clearing, messages could duplicate (especially those without stable UUIDs).
  useEffect(() => {
    if (ws.connectionStatus === 'connected') {
      if (wasConnectedRef.current) {
        // This is a reconnection - clear state to receive fresh messages from server
        setRawMessages([])
        setActiveTodos([])
        setProgressMessage(null)
        permissions.reset()
        initialLoadCompleteRef.current = false
        if (initialLoadTimerRef.current) {
          clearTimeout(initialLoadTimerRef.current)
          initialLoadTimerRef.current = null
        }
      }
      wasConnectedRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- permissions.reset is stable
  }, [ws.connectionStatus])

  // ============================================================================
  // Handlers
  // ============================================================================

  // Send message via WebSocket
  const sendMessage = useCallback(
    async (content: string) => {
      setOptimisticMessage(content)

      try {
        await ws.sendMessage({
          type: 'user_message',
          content,
        })
      } catch (error) {
        console.error('Failed to send message:', error)
        setError('Failed to send message. Please try again.')
        setOptimisticMessage(null)
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
    [permissions.buildPermissionResponse, permissions.handleControlResponse, ws.sendMessage]
  )

  // Handle question answer - send tool_result back to Claude
  const handleQuestionAnswer = useCallback(
    async (questionId: string, answers: Record<string, string | string[]>) => {
      // Format the answer for Claude
      const answerText = Object.entries(answers)
        .map(([key, value]) => {
          const answer = Array.isArray(value) ? value.join(', ') : value
          return `${key}: ${answer}`
        })
        .join('\n')

      try {
        await ws.sendMessage({
          type: 'tool_result',
          tool_use_id: questionId,
          content: `User selected: ${answerText}`,
        })
      } catch (error) {
        console.error('[ChatInterface] Failed to send question answer:', error)
        setError('Failed to send answer')
        setTimeout(() => setError(null), 3000)
      }
    },
    [ws.sendMessage]
  )

  // Handle question skip - send empty/skipped tool_result
  const handleQuestionSkip = useCallback(
    async (questionId: string) => {
      try {
        await ws.sendMessage({
          type: 'tool_result',
          tool_use_id: questionId,
          content: 'User skipped this question',
        })
      } catch (error) {
        console.error('[ChatInterface] Failed to send question skip:', error)
        setError('Failed to skip question')
        setTimeout(() => setError(null), 3000)
      }
    },
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
  }, [isWorking, ws.sendMessage])

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
            wipText={
              isWorking
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
          />
        </div>

        {/* Todo Panel (collapsible) */}
        {activeTodos.length > 0 && <TodoPanel todos={activeTodos} />}
      </div>
    </div>
  )
}
