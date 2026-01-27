import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { MessageList } from './message-list'
import { ChatInput } from './chat-input'
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

export function ChatInterface({
  sessionId,
  isActive,
  refreshSessions,
}: ChatInterfaceProps) {
  // Raw session messages - store as-is from WebSocket
  const [rawMessages, setRawMessages] = useState<SessionMessage[]>([])
  const [_wsConnected, setWsConnected] = useState(false)
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

  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null)

  // Track if we've refreshed sessions for this inactive session (to avoid multiple refreshes)
  const hasRefreshedRef = useRef(false)
  // Keep isActive in a ref so WebSocket handler can access latest value
  const isActiveRef = useRef(isActive)

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
    hasRefreshedRef.current = false // Reset refresh tracking for new session
    // Note: isWorking is derived from rawMessages + optimisticMessage, so it resets automatically
  }, [sessionId])

  // WebSocket connection for real-time updates
  // Backend sends cached messages on connect, then real-time updates
  // Always connect - backend will activate session lazily on first message
  useEffect(() => {
    console.log('[ChatInterface] Connecting WebSocket for session:', sessionId)

    // Connect to subscribe endpoint
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/claude/sessions/${sessionId}/subscribe`

    console.log('[ChatInterface] WebSocket URL:', wsUrl)
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[ChatInterface] WebSocket connected')
      setWsConnected(true)
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        // Handle error messages
        if (data.type === 'error') {
          console.error('[ChatInterface] Error from server:', data.error)
          setError(data.error || 'An error occurred')
          // Clear error after 5 seconds
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

        // Handle progress updates - show WIP indicator AND store for rendering
        if (data.type === 'progress') {
          const progressData = data.data
          let msg: string | null = null

          if (progressData?.type === 'bash_progress') {
            // Bash progress: show elapsed time and line count
            const elapsed = progressData.elapsedTimeSeconds || 0
            const lines = progressData.totalLines || 0
            msg = `Running command... (${elapsed}s${lines > 0 ? `, ${lines} lines` : ''})`
          } else if (progressData?.type === 'hook_progress') {
            // Hook progress: show hook name
            msg = progressData.hookName || 'Running hook...'
          } else if (progressData?.type === 'agent_progress') {
            // Agent progress: show agent ID and truncated prompt
            const agentId = progressData.agentId || 'unknown'
            const prompt = progressData.prompt || ''
            const truncatedPrompt = prompt.length > 50 ? prompt.slice(0, 50) + '...' : prompt
            msg = `Agent ${agentId}: ${truncatedPrompt || 'Working...'}`
          } else if (progressData?.type === 'query_update') {
            // Web search: show query
            msg = `Searching: ${progressData.query || '...'}`
          } else if (progressData?.type === 'search_results_received') {
            // Web search results
            msg = `Found ${progressData.resultCount || 0} results for: ${progressData.query || '...'}`
          } else {
            // Fallback for unknown progress types
            msg = data.message || progressData?.message || `Progress: ${progressData?.type || 'unknown'}`
          }

          setProgressMessage(msg)
          console.log('[ChatInterface] Received progress:', progressData?.type, msg)
          // Don't return - let progress messages be stored and rendered as raw JSON
        }

        // Handle result messages - Claude's turn is complete (session terminator)
        // Note: isWorking is derived from messages, so it will update automatically
        // when the result message is added to rawMessages
        if (data.type === 'result') {
          console.log('[ChatInterface] Received result (turn complete):', data.subtype, 'duration:', data.duration_ms)
          setProgressMessage(null)
          // Store result message so deriveIsWorking can see it
          setRawMessages((prev) => {
            const resultMsg: SessionMessage = {
              type: 'result',
              uuid: data.uuid || crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              ...data,
            }
            // Check if already exists
            const exists = prev.some((m) => m.uuid === resultMsg.uuid)
            if (exists) return prev
            return [...prev, resultMsg]
          })
          return
        }

        // Handle control_request - permission needed for tool use
        // Track in controlRequests map - pendingPermission is derived from requests without responses
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

        // Handle control_response - permission was resolved (possibly by another tab)
        // Track in controlResponses set - this will cause pendingPermission to be recalculated
        if (data.type === 'control_response') {
          console.log('[ChatInterface] Received control_response:', data.request_id, data.behavior)
          setControlResponses((prev) => {
            const next = new Set(prev)
            next.add(data.request_id)
            return next
          })
          return
        }

        // Handle system init message (sent at session start with tools, model, etc.)
        // Store as a regular SessionMessage
        if (data.type === 'system' && data.subtype === 'init') {
          console.log('[ChatInterface] Received system init:', data.session_id, data.model)
          const initMsg: SessionMessage = {
            type: 'system',
            uuid: data.uuid || crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            // Store the full init data for rendering
            ...data,
          }
          setRawMessages((prev) => {
            // Check if init message already exists
            const exists = prev.some((m) => m.uuid === initMsg.uuid)
            if (exists) return prev
            // Add init message at the beginning
            return [initMsg, ...prev]
          })
          return
        }

        // Handle SessionMessage format - store raw
        const sessionMsg: SessionMessage = data
        console.log('[ChatInterface] Received message:', sessionMsg.type, sessionMsg.uuid)

        // Clear optimistic message when we receive the real user message (not tool results)
        if (sessionMsg.type === 'user' && !hasToolUseResult(sessionMsg)) {
          setOptimisticMessage(null)
        }

        // If assistant message, clear progress
        if (sessionMsg.type === 'assistant') {
          setProgressMessage(null)
        }

        // If we receive a message while session was marked inactive, refresh session list
        // This indicates the session has been activated by the backend
        if (isActiveRef.current === false && !hasRefreshedRef.current && refreshSessions) {
          hasRefreshedRef.current = true
          refreshSessions()
        }

        // Accumulate raw messages
        setRawMessages((prev) => {
          // Check if message already exists
          const existingIndex = prev.findIndex((m) => m.uuid === sessionMsg.uuid)
          if (existingIndex >= 0) {
            // Update existing message
            const updated = [...prev]
            updated[existingIndex] = sessionMsg
            return updated
          }
          return [...prev, sessionMsg]
        })
      } catch (error) {
        console.error('[ChatInterface] Failed to parse WebSocket message:', error)
      }
    }

    ws.onerror = (error) => {
      console.error('[ChatInterface] WebSocket error:', error)
      setWsConnected(false)
    }

    ws.onclose = () => {
      console.log('[ChatInterface] WebSocket disconnected')
      setWsConnected(false)
    }

    return () => {
      console.log('[ChatInterface] Cleaning up WebSocket')
      ws.close()
      wsRef.current = null
    }
    // Note: refreshSessions intentionally excluded - it's called conditionally via ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Send message to server via WebSocket
  const sendMessage = useCallback(
    async (content: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.error('WebSocket not connected')
        return
      }

      // Show optimistic message immediately (also triggers isWorking via useMemo)
      setOptimisticMessage(content)

      try {
        // Send message via WebSocket
        wsRef.current.send(JSON.stringify({
          type: 'user_message',
          content,
        }))

        console.log('[ChatInterface] Sent message via WebSocket:', content)
      } catch (error) {
        console.error('Failed to send message:', error)
        setError('Failed to send message. Please try again.')
        setOptimisticMessage(null)
        // Clear error after 5 seconds
        setTimeout(() => setError(null), 5000)
      }
    },
    []
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
            onSend={sendMessage}
            pendingPermissions={pendingPermissions}
            onPermissionDecision={handlePermissionDecision}
            hiddenOnMobile={shouldHideInput}
            isWorking={isWorking}
            onInterrupt={handleInterrupt}
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
