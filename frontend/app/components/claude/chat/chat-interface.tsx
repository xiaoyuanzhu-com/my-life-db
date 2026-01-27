import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { MessageList } from './message-list'
import { ChatInput } from './chat-input'
import { TodoPanel } from './todo-panel'
import { AskUserQuestion } from './ask-user-question'
import type {
  TodoItem,
  PermissionRequest,
  UserQuestion,
  PermissionDecision,
  ControlRequest,
  ControlResponse,
} from '~/types/claude'
import {
  buildToolResultMap,
  hasToolUseResult,
  type SessionMessage,
} from '~/lib/session-message-utils'

interface ChatInterfaceProps {
  sessionId: string
  sessionName?: string
  workingDir?: string
  onSessionNameChange?: (name: string) => void
}

// Types that should not be rendered as messages
const SKIP_TYPES = ['file-history-snapshot']

export function ChatInterface({
  sessionId,
}: ChatInterfaceProps) {
  // Raw session messages - store as-is from WebSocket
  const [rawMessages, setRawMessages] = useState<SessionMessage[]>([])
  const [wsConnected, setWsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Optimistic user message (shown immediately before server confirms)
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null)

  // Tool state - kept for future implementation
  const [activeTodos, setActiveTodos] = useState<TodoItem[]>([])
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<UserQuestion | null>(null)

  // Progress state - shows WIP indicator when Claude is working
  const [progressMessage, setProgressMessage] = useState<string | null>(null)

  // Working state - tracks whether Claude is actively processing (between user message and result)
  const [isWorking, setIsWorking] = useState(false)

  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null)

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

  // Clear messages and reset state when sessionId changes
  useEffect(() => {
    setRawMessages([])
    setOptimisticMessage(null)
    setActiveTodos([])
    setError(null)
    setProgressMessage(null)
    setIsWorking(false)
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
        if (data.type === 'result') {
          console.log('[ChatInterface] Received result (turn complete):', data.subtype, 'duration:', data.duration_ms)
          setIsWorking(false)
          setProgressMessage(null)
          return
        }

        // Handle control_request - permission needed for tool use
        if (data.type === 'control_request' && data.request?.subtype === 'can_use_tool') {
          console.log('[ChatInterface] Received control_request:', data.request_id, data.request.tool_name)
          setPendingPermission({
            requestId: data.request_id,
            toolName: data.request.tool_name,
            input: data.request.input || {},
          })
          return
        }

        // Handle control_response - permission was resolved (possibly by another tab)
        // Clear pending permission if request_id matches
        if (data.type === 'control_response') {
          console.log('[ChatInterface] Received control_response:', data.request_id, data.behavior)
          setPendingPermission((current) => {
            if (current?.requestId === data.request_id) {
              return null
            }
            return current
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
  }, [sessionId])

  // Send message to server via WebSocket
  const sendMessage = useCallback(
    async (content: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.error('WebSocket not connected')
        return
      }

      // Mark as working - Claude is now processing
      setIsWorking(true)

      // Show optimistic message immediately
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
    [sessionId]
  )

  // Handle permission decision - send control_response via WebSocket
  const handlePermissionDecision = useCallback(
    (decision: PermissionDecision) => {
      if (!pendingPermission) {
        console.warn('[ChatInterface] No pending permission to respond to')
        return
      }

      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.error('[ChatInterface] WebSocket not connected, cannot send permission response')
        setPendingPermission(null)
        return
      }

      // Map our decision to Claude's behavior format
      const behavior = decision === 'deny' ? 'deny' : 'allow'
      const alwaysAllow = decision === 'allowSession'

      // Build control_response with always_allow and tool_name for backend tracking
      const response: ControlResponse = {
        type: 'control_response',
        request_id: pendingPermission.requestId,
        response: {
          subtype: 'success',
          response: {
            behavior,
          },
        },
        // Send tool_name and always_allow for "always allow for session" feature
        tool_name: pendingPermission.toolName,
        always_allow: alwaysAllow,
      }

      console.log('[ChatInterface] Sending permission response:', response, 'decision:', decision)
      wsRef.current.send(JSON.stringify(response))
      setPendingPermission(null)
    },
    [pendingPermission]
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
        <div className="flex flex-1 flex-col">
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
          />

          <ChatInput
            onSend={sendMessage}
            pendingPermission={pendingPermission}
            onPermissionDecision={handlePermissionDecision}
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
