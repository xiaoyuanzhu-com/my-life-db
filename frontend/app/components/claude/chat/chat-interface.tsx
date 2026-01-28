import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { MessageList } from './message-list'
import { ChatInput, type ChatInputHandle, type ConnectionStatus } from './chat-input'
import { TodoPanel } from './todo-panel'
import { AskUserQuestion } from './ask-user-question'
import { useHideOnScroll } from '~/hooks/use-hide-on-scroll'
import type {
  TodoItem,
  PermissionRequest,
  UserQuestion,
  PermissionDecision,
  ControlResponse,
} from '~/types/claude'
import {
  buildToolResultMap,
  deriveIsWorking,
  hasToolUseResult,
  type SessionMessage,
} from '~/lib/session-message-utils'

interface ChatInterfaceProps {
  sessionId: string
  sessionName?: string
  workingDir?: string
  isActive?: boolean // Whether session has a running CLI process
  onSessionNameChange?: (name: string) => void
  refreshSessions?: () => void // Called to refresh session list from backend
}

// Types that should not be rendered as messages
const SKIP_TYPES = ['file-history-snapshot', 'result']

/** Extract text content from a user message (for draft comparison) */
function extractUserMessageText(msg: SessionMessage): string | null {
  if (msg.type !== 'user') return null
  const message = msg.message as { content?: Array<{ type: string; text?: string }> } | undefined
  if (!message?.content) return null
  const textBlock = message.content.find((b) => b.type === 'text')
  return textBlock?.text ?? null
}

export function ChatInterface({
  sessionId,
  isActive,
  refreshSessions,
}: ChatInterfaceProps) {
  // Raw session messages - store as-is from WebSocket
  const [rawMessages, setRawMessages] = useState<SessionMessage[]>([])
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const [error, setError] = useState<string | null>(null)

  // Optimistic user message (shown immediately before server confirms)
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null)

  // Tool state - kept for future implementation
  const [activeTodos, setActiveTodos] = useState<TodoItem[]>([])
  const [pendingQuestion, setPendingQuestion] = useState<UserQuestion | null>(null)

  // Permission tracking - maps request_id to request/response data
  // Pending permission = control_request without matching control_response
  const [controlRequests, setControlRequests] = useState<Map<string, PermissionRequest>>(new Map())
  const [controlResponses, setControlResponses] = useState<Set<string>>(new Set())

  // Progress state - shows WIP indicator when Claude is working
  const [progressMessage, setProgressMessage] = useState<string | null>(null)

  // WebSocket ref and connection state
  const wsRef = useRef<WebSocket | null>(null)
  const connectPromiseRef = useRef<Promise<WebSocket> | null>(null)

  // ChatInput ref for draft lifecycle management
  const chatInputRef = useRef<ChatInputHandle>(null)
  const isComponentActiveRef = useRef(true)

  // Track if we've refreshed sessions for this inactive session (to avoid multiple refreshes)
  const hasRefreshedRef = useRef(false)
  // Keep isActive in a ref so WebSocket handler can access latest value
  const isActiveRef = useRef(isActive)
  // Track if we've ever successfully connected (to avoid showing banner on initial load)
  const hasConnectedRef = useRef(false)

  // Scroll container element for hide-on-scroll behavior
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

  // Hide input on mobile when scrolling up (show when scrolling down or at bottom)
  const { shouldHide: shouldHideInput } = useHideOnScroll(scrollElement, {
    threshold: 50,
    bottomThreshold: 100,
  })

  // Build tool result map from raw messages (derived state)
  const toolResultMap = useMemo(() => buildToolResultMap(rawMessages), [rawMessages])

  // Filter messages for rendering (derived state)
  const renderableMessages = useMemo(() => {
    return rawMessages.filter((msg) => {
      // Skip internal event types
      if (SKIP_TYPES.includes(msg.type)) return false
      // Skip tool result messages (they're used to populate toolResultMap, not rendered directly)
      // Note: hasToolUseResult handles both camelCase (JSONL) and snake_case (stdout) field names
      if (msg.type === 'user' && hasToolUseResult(msg)) return false
      return true
    })
  }, [rawMessages])

  // Derive working state from message history and session active state
  // Uses optimisticMessage for immediate feedback, then derives from messages
  const isWorking = useMemo(() => {
    // If session is not active (no CLI process), Claude can't be working
    if (isActive === false) return false
    // Optimistic message = user just sent something, Claude is working
    if (optimisticMessage) return true
    // Derive from message history (handles second tab case)
    return deriveIsWorking(rawMessages)
  }, [rawMessages, optimisticMessage, isActive])

  // Compute pending permissions from control_request/control_response tracking
  // Pending = control_requests without matching control_response
  const pendingPermissions = useMemo(() => {
    const pending: PermissionRequest[] = []
    for (const [requestId, request] of controlRequests) {
      if (!controlResponses.has(requestId)) {
        pending.push(request)
      }
    }
    return pending
  }, [controlRequests, controlResponses])

  // Only show connection status banner after we've connected at least once
  // This avoids showing "Reconnecting..." on initial page load
  const effectiveConnectionStatus: ConnectionStatus =
    hasConnectedRef.current && connectionStatus !== 'connected'
      ? connectionStatus
      : 'connected'

  // Keep isActiveRef in sync
  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  // Clear messages and reset state when sessionId changes
  useEffect(() => {
    setRawMessages([])
    setOptimisticMessage(null)
    setActiveTodos([])
    setControlRequests(new Map())
    setControlResponses(new Set())
    setError(null)
    setProgressMessage(null)
    setConnectionStatus('connecting') // Reset to connecting for new session
    hasRefreshedRef.current = false // Reset refresh tracking for new session
    hasConnectedRef.current = false // Reset connection tracking for new session
    // Note: isWorking is derived from rawMessages + optimisticMessage, so it resets automatically
  }, [sessionId])

  // WebSocket message handler - extracted so it can be reused across connections
  const handleWsMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data)

      // Handle error messages
      if (data.type === 'error') {
        console.error('[ChatInterface] Error from server:', data.error)
        setError(data.error || 'An error occurred')
        setTimeout(() => setError(null), 5000)
        return
      }

      // Handle todo updates
      if (data.type === 'todo_update') {
        const todos: TodoItem[] = data.data?.todos || []
        setActiveTodos(todos)
        console.log('[ChatInterface] Received todo update:', todos)
        return
      }

      // Handle progress updates
      if (data.type === 'progress') {
        const progressData = data.data
        let msg: string | null = null

        if (progressData?.type === 'bash_progress') {
          const elapsed = progressData.elapsedTimeSeconds || 0
          const lines = progressData.totalLines || 0
          msg = `Running command... (${elapsed}s${lines > 0 ? `, ${lines} lines` : ''})`
        } else if (progressData?.type === 'hook_progress') {
          msg = progressData.hookName || 'Running hook...'
        } else if (progressData?.type === 'agent_progress') {
          const agentId = progressData.agentId || 'unknown'
          const prompt = progressData.prompt || ''
          const truncatedPrompt = prompt.length > 50 ? prompt.slice(0, 50) + '...' : prompt
          msg = `Agent ${agentId}: ${truncatedPrompt || 'Working...'}`
        } else if (progressData?.type === 'query_update') {
          msg = `Searching: ${progressData.query || '...'}`
        } else if (progressData?.type === 'search_results_received') {
          msg = `Found ${progressData.resultCount || 0} results for: ${progressData.query || '...'}`
        } else {
          msg = data.message || progressData?.message || `Progress: ${progressData?.type || 'unknown'}`
        }

        setProgressMessage(msg)
        console.log('[ChatInterface] Received progress:', progressData?.type, msg)
      }

      // Handle result messages
      if (data.type === 'result') {
        console.log('[ChatInterface] Received result (turn complete):', data.subtype, 'duration:', data.duration_ms)
        setProgressMessage(null)
        setRawMessages((prev) => {
          const resultMsg: SessionMessage = {
            type: 'result',
            uuid: data.uuid || crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            ...data,
          }
          const exists = prev.some((m) => m.uuid === resultMsg.uuid)
          if (exists) return prev
          return [...prev, resultMsg]
        })
        return
      }

      // Handle control_request
      if (data.type === 'control_request' && data.request?.subtype === 'can_use_tool') {
        console.log('[ChatInterface] Received control_request:', data.request_id, data.request.tool_name)
        setControlRequests((prev) => {
          const next = new Map(prev)
          next.set(data.request_id, {
            requestId: data.request_id,
            toolName: data.request.tool_name,
            input: data.request.input || {},
          })
          return next
        })
        return
      }

      // Handle control_response
      if (data.type === 'control_response') {
        console.log('[ChatInterface] Received control_response:', data.request_id, data.behavior)
        setControlResponses((prev) => {
          const next = new Set(prev)
          next.add(data.request_id)
          return next
        })
        return
      }

      // Handle system init message
      if (data.type === 'system' && data.subtype === 'init') {
        console.log('[ChatInterface] Received system init:', data.session_id, data.model)
        const initMsg: SessionMessage = {
          type: 'system',
          uuid: data.uuid || crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          ...data,
        }
        setRawMessages((prev) => {
          const exists = prev.some((m) => m.uuid === initMsg.uuid)
          if (exists) return prev
          return [initMsg, ...prev]
        })
        return
      }

      // Handle SessionMessage format
      const sessionMsg: SessionMessage = data
      console.log('[ChatInterface] Received message:', sessionMsg.type, sessionMsg.uuid)

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

      if (isActiveRef.current === false && !hasRefreshedRef.current && refreshSessions) {
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
    } catch (error) {
      console.error('[ChatInterface] Failed to parse WebSocket message:', error)
    }
  }, [refreshSessions])

  // Lazy WebSocket connection - connects on demand with infinite retry
  // Uses exponential backoff with max delay of 60 seconds
  const ensureConnected = useCallback((): Promise<WebSocket> => {
    // If already connected, return immediately
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return Promise.resolve(wsRef.current)
    }

    // If connection in progress, return existing promise
    if (connectPromiseRef.current) {
      return connectPromiseRef.current
    }

    // Start new connection with infinite retry and exponential backoff
    const baseDelay = 1000
    const maxDelay = 60000 // 1 minute max

    connectPromiseRef.current = new Promise((resolve) => {
      let attempts = 0
      let wasConnected = false

      const tryConnect = () => {
        if (!isComponentActiveRef.current) {
          connectPromiseRef.current = null
          return
        }

        attempts++
        console.log(`[ChatInterface] Connecting WebSocket (attempt ${attempts})`)

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsUrl = `${protocol}//${window.location.host}/api/claude/sessions/${sessionId}/subscribe`

        const ws = new WebSocket(wsUrl)
        wsRef.current = ws

        ws.onopen = () => {
          console.log('[ChatInterface] WebSocket connected')
          setConnectionStatus('connected')
          hasConnectedRef.current = true
          wasConnected = true
          attempts = 0 // Reset attempts on successful connection
          connectPromiseRef.current = null
          resolve(ws)
        }

        ws.onmessage = handleWsMessage

        ws.onerror = (error) => {
          console.error('[ChatInterface] WebSocket error:', error)
        }

        ws.onclose = () => {
          console.log('[ChatInterface] WebSocket disconnected')
          wsRef.current = null

          if (!isComponentActiveRef.current) return

          // Calculate delay with exponential backoff, capped at maxDelay
          const delay = Math.min(baseDelay * Math.pow(2, attempts - 1), maxDelay)

          if (wasConnected) {
            // Was connected, now disconnected - start background reconnection
            console.log(`[ChatInterface] Connection lost, reconnecting in ${delay}ms...`)
            setConnectionStatus('connecting')
            connectPromiseRef.current = null
            setTimeout(() => {
              ensureConnected()
            }, delay)
          } else if (connectPromiseRef.current) {
            // Still in initial connection phase, keep retrying
            console.log(`[ChatInterface] Connection failed, retrying in ${delay}ms...`)
            setConnectionStatus('connecting')
            setTimeout(tryConnect, delay)
          }
        }
      }

      tryConnect()
    })

    return connectPromiseRef.current
  }, [sessionId, handleWsMessage])

  // Connect on mount, cleanup on unmount or sessionId change
  useEffect(() => {
    isComponentActiveRef.current = true

    // Connect immediately (infinite retry, never rejects)
    ensureConnected()

    return () => {
      console.log('[ChatInterface] Cleaning up WebSocket')
      isComponentActiveRef.current = false
      connectPromiseRef.current = null
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
    // ensureConnected is stable for a given sessionId, so only sessionId needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Send message - connects lazily if needed
  const sendMessage = useCallback(
    async (content: string) => {
      // Show optimistic message immediately
      setOptimisticMessage(content)

      try {
        const ws = await ensureConnected()
        ws.send(JSON.stringify({
          type: 'user_message',
          content,
        }))
        console.log('[ChatInterface] Sent message via WebSocket:', content)
      } catch (error) {
        console.error('Failed to send message:', error)
        setError('Failed to send message. Please try again.')
        setOptimisticMessage(null)
        // Restore draft so user doesn't lose their input
        chatInputRef.current?.restoreDraft()
        setTimeout(() => setError(null), 3000)
      }
    },
    [ensureConnected]
  )

  // Handle permission decision - send control_response via WebSocket
  const handlePermissionDecision = useCallback(
    (requestId: string, decision: PermissionDecision) => {
      const request = controlRequests.get(requestId)
      if (!request) {
        console.warn('[ChatInterface] No permission request found for id:', requestId)
        return
      }

      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.error('[ChatInterface] WebSocket not connected, cannot send permission response')
        // Mark as responded locally to clear the UI
        setControlResponses((prev) => new Set(prev).add(requestId))
        return
      }

      // Map our decision to Claude's behavior format
      const behavior = decision === 'deny' ? 'deny' : 'allow'
      const alwaysAllow = decision === 'allowSession'

      // Build control_response with always_allow and tool_name for backend tracking
      const response: ControlResponse = {
        type: 'control_response',
        request_id: requestId,
        response: {
          subtype: 'success',
          response: {
            behavior,
            // Include message for deny (required by Anthropic API - content can't be empty when is_error=true)
            ...(behavior === 'deny' && { message: `Permission denied by user for tool: ${request.toolName}` }),
          },
        },
        // Send tool_name and always_allow for "always allow for session" feature
        tool_name: request.toolName,
        always_allow: alwaysAllow,
      }

      console.log('[ChatInterface] Sending permission response:', response, 'decision:', decision)
      wsRef.current.send(JSON.stringify(response))
      // Note: We'll receive the control_response broadcast back from the server,
      // which will add to controlResponses and clear pendingPermission automatically.
      // But we add it locally too for immediate UI feedback.
      setControlResponses((prev) => new Set(prev).add(requestId))
    },
    [controlRequests]
  )

  // Handle question answer (placeholder for future implementation)
  const handleQuestionAnswer = useCallback(
    (answers: Record<string, string | string[]>) => {
      // TODO: Implement question handling via HTTP
      console.log('Question answers:', answers)
      setPendingQuestion(null)
    },
    []
  )

  // Handle interrupt - stop Claude's current operation
  const handleInterrupt = useCallback(async () => {
    if (!isWorking) return

    try {
      console.log('[ChatInterface] Interrupting session:', sessionId)
      const response = await fetch(`/api/claude/sessions/${sessionId}/interrupt`, {
        method: 'POST',
      })

      if (!response.ok) {
        const data = await response.json()
        console.error('[ChatInterface] Interrupt failed:', data.error)
        setError(data.error || 'Failed to interrupt session')
        setTimeout(() => setError(null), 5000)
        return
      }

      console.log('[ChatInterface] Session interrupted successfully')
      // Note: isWorking will be set to false when we receive the result message
    } catch (error) {
      console.error('[ChatInterface] Interrupt error:', error)
      setError('Failed to interrupt session')
      setTimeout(() => setError(null), 5000)
    }
  }, [sessionId, isWorking])

  return (
    <div className="flex h-full flex-col claude-bg">
      {/* Error Banner */}
      {error && (
        <div className="bg-destructive/10 border-b border-destructive/30 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Messages */}
        <div className="flex flex-1 flex-col min-w-0">
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
            pendingPermissions={pendingPermissions}
            onPermissionDecision={handlePermissionDecision}
            hiddenOnMobile={shouldHideInput}
            isWorking={isWorking}
            onInterrupt={handleInterrupt}
            connectionStatus={effectiveConnectionStatus}
          />
        </div>

        {/* Todo Panel (collapsible) */}
        {activeTodos.length > 0 && (
          <TodoPanel todos={activeTodos} />
        )}
      </div>

      {/* User Question Modal */}
      {pendingQuestion && (
        <AskUserQuestion
          question={pendingQuestion}
          onAnswer={handleQuestionAnswer}
          onSkip={() => setPendingQuestion(null)}
        />
      )}
    </div>
  )
}
