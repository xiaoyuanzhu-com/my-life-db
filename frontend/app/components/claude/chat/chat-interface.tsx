import { useState, useEffect, useCallback, useRef } from 'react'
import { MessageList } from './message-list'
import { ChatInput } from './chat-input'
import { TodoPanel } from './todo-panel'
import { PermissionModal } from './permission-modal'
import { AskUserQuestion } from './ask-user-question'
import { ClaudeWIP } from './claude-wip'
import type {
  Message,
  ToolCall,
  TodoItem,
  PermissionRequest,
  UserQuestion,
  PermissionDecision,
} from '~/types/claude'
import {
  useClaudeSessionHistory,
  buildToolResultMap,
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
  isToolResultError,
  isBashToolResult,
  type SessionMessage,
  type ExtractedToolResult,
} from '~/hooks/use-claude-session-history'

interface ChatInterfaceProps {
  sessionId: string
  sessionName?: string
  workingDir?: string
  onSessionNameChange?: (name: string) => void
}

export function ChatInterface({
  sessionId,
}: ChatInterfaceProps) {
  // Load structured history from JSONL files (initial load only)
  const { messages: historyMessages, isLoading: historyLoading, error: historyError } = useClaudeSessionHistory(sessionId)

  // Message state
  const [messages, setMessages] = useState<Message[]>([])
  const [wsConnected, setWsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  // Accumulated session messages for building tool result map during real-time updates
  const accumulatedMessagesRef = useRef<SessionMessage[]>([])

  // Convert SessionMessage to Message format
  // toolResultMap is used to attach results to tool calls
  const convertToMessage = (
    sessionMsg: SessionMessage,
    toolResultMap: Map<string, ExtractedToolResult>
  ): Message | null => {
    // Skip known internal events that shouldn't be rendered
    const skipTypes = ['queue-operation', 'summary', 'custom-title', 'tag', 'agent-name', 'file-history-snapshot', 'progress']
    if (skipTypes.includes(sessionMsg.type)) {
      return null
    }

    // Handle unknown message types - render raw JSON for debugging
    if (!sessionMsg.message || (sessionMsg.type !== 'user' && sessionMsg.type !== 'assistant')) {
      return {
        id: sessionMsg.uuid || crypto.randomUUID(),
        role: 'system',
        content: JSON.stringify(sessionMsg, null, 2),
        timestamp: new Date(sessionMsg.timestamp).getTime(),
        systemType: sessionMsg.type,
      }
    }

    const { content, role } = sessionMsg.message

    // Handle content - can be string (user messages) or array (assistant messages)
    let textContent = ''
    let toolCalls: ToolCall[] = []
    let thinkingBlocks: { type: 'thinking'; thinking: string; signature?: string }[] = []

    if (typeof content === 'string') {
      // User message with plain text content
      textContent = content
    } else if (Array.isArray(content)) {
      // Assistant message with structured content blocks
      // Extract text from text blocks
      const textBlocks = content.filter(isTextBlock).map(block => block.text)
      textContent = textBlocks.join('\n')

      // Extract thinking blocks
      thinkingBlocks = content
        .filter(isThinkingBlock)
        .map(block => ({
          type: 'thinking' as const,
          thinking: block.thinking,
          signature: block.signature,
        }))

      // Extract tool calls from tool_use blocks and attach results
      toolCalls = content
        .filter(isToolUseBlock)
        .map((block): ToolCall => {
          const toolResult = toolResultMap.get(block.id)

          // Determine result and error based on toolUseResult format
          let result: unknown = undefined
          let error: string | undefined = undefined
          let status: ToolCall['status'] = toolResult ? 'completed' : 'pending'

          if (toolResult) {
            if (isToolResultError(toolResult.toolUseResult)) {
              // Error case: toolUseResult is a string
              error = toolResult.toolUseResult
              status = 'failed'
            } else if (isBashToolResult(toolResult.toolUseResult)) {
              // Bash success: extract stdout/stderr
              const bashResult = toolResult.toolUseResult
              result = {
                output: bashResult.stdout || '',
                exitCode: toolResult.isError ? 1 : 0,
              }
              if (toolResult.isError) {
                status = 'failed'
              }
            } else {
              // Other tool results: pass through the toolUseResult
              result = toolResult.toolUseResult || toolResult.content
            }
          }

          return {
            id: block.id,
            name: block.name as ToolCall['name'],
            parameters: block.input,
            status,
            result,
            error,
          }
        })
    }

    return {
      id: sessionMsg.uuid,
      role: role || 'user',
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      thinking: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      timestamp: new Date(sessionMsg.timestamp).getTime(),
    }
  }

  // Clear messages and reset state when sessionId changes
  useEffect(() => {
    setMessages([])
    setActiveTodos([])
    setError(null)
    setProgressMessage(null)
    setIsWorking(false)
    accumulatedMessagesRef.current = []
  }, [sessionId])

  // Load history and convert to Message format
  useEffect(() => {
    console.log('[ChatInterface] Loading history for session:', sessionId, 'message count:', historyMessages.length)

    // Initialize accumulated messages ref from history for WebSocket tool result mapping
    accumulatedMessagesRef.current = [...historyMessages]

    // Build tool result map from all messages first
    const toolResultMap = buildToolResultMap(historyMessages)

    // Convert all messages - convertToMessage handles skipping internal events
    const converted = historyMessages
      .map((msg) => convertToMessage(msg, toolResultMap))
      .filter((m): m is Message => m !== null)
    setMessages(converted)

    // Check if session is still working (Claude actively processing)
    // Per data-models.md: "Before receiving `result`, Claude is still working"
    // We check multiple signals to avoid false positives:
    // 1. If there's a `result` message → completed
    // 2. If assistant message has stop_reason (e.g., "end_turn") → completed
    // 3. If session data is stale (old timestamp) → assume completed
    if (historyMessages.length > 0) {
      const lastConversationMsg = [...historyMessages].reverse().find(m => m.type === 'user' || m.type === 'assistant')

      if (lastConversationMsg?.type === 'assistant') {
        // Check if there's a result after the last assistant message
        const lastAssistantIdx = historyMessages.findIndex(m => m.uuid === lastConversationMsg.uuid)
        const hasResultAfter = historyMessages.slice(lastAssistantIdx).some(m => m.type === 'result')

        // Check if assistant message has a stop_reason (indicates completion)
        const stopReason = lastConversationMsg.message?.stop_reason
        const hasStopReason = stopReason !== null && stopReason !== undefined

        // Check if the message is recent (within last 60 seconds)
        const messageTime = new Date(lastConversationMsg.timestamp).getTime()
        const isRecent = Date.now() - messageTime < 60000

        // Only show working if: no result, no stop_reason, AND message is recent
        if (!hasResultAfter && !hasStopReason && isRecent) {
          setIsWorking(true)
        }
      }
    }
  }, [historyMessages])

  // WebSocket connection for real-time updates
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

        // Handle progress updates - show WIP indicator
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
          } else {
            // Fallback for unknown progress types
            msg = data.message || progressData?.message || null
          }

          setProgressMessage(msg)
          console.log('[ChatInterface] Received progress:', progressData?.type, msg)
          return
        }

        // Handle result messages - Claude's turn is complete (session terminator)
        if (data.type === 'result') {
          console.log('[ChatInterface] Received result (turn complete):', data.subtype, 'duration:', data.duration_ms)
          setIsWorking(false)
          setProgressMessage(null)
          return
        }

        // Handle system init message (sent at session start with tools, model, etc.)
        if (data.type === 'system' && data.subtype === 'init') {
          console.log('[ChatInterface] Received system init:', data.session_id, data.model)
          const initMessage: Message = {
            id: data.uuid || crypto.randomUUID(),
            role: 'system',
            content: JSON.stringify(data, null, 2),
            timestamp: Date.now(),
            systemType: 'system',
          }
          setMessages((prev) => {
            // Check if init message already exists
            const existingIndex = prev.findIndex((m) => m.id === initMessage.id)
            if (existingIndex >= 0) {
              return prev
            }
            // Add init message at the beginning
            return [initMessage, ...prev]
          })
          return
        }

        // Handle SessionMessage format
        const sessionMsg: SessionMessage = data
        console.log('[ChatInterface] Received message:', sessionMsg.type, sessionMsg.uuid)

        // Accumulate all messages (including tool results) for building the map
        accumulatedMessagesRef.current = [...accumulatedMessagesRef.current, sessionMsg]

        // Build tool result map from accumulated messages
        const toolResultMap = buildToolResultMap(accumulatedMessagesRef.current)

        // Convert to Message format and append
        const converted = convertToMessage(sessionMsg, toolResultMap)
        if (converted) {
          setMessages((prev) => {
            // Clear all optimistic messages when we receive any server message
            const withoutOptimistic = prev.filter((m) => !m.isOptimistic)

            // Check if message already exists (by uuid)
            const existingIndex = withoutOptimistic.findIndex((m) => m.id === converted.id)
            if (existingIndex >= 0) {
              // Update existing message (tool results may have arrived)
              const updated = [...withoutOptimistic]
              updated[existingIndex] = converted
              return updated
            }

            return [...withoutOptimistic, converted]
          })

          // If we received an assistant message, clear progress
          if (converted.role === 'assistant') {
            setProgressMessage(null)
          }
        } else if (sessionMsg.toolUseResult) {
          // This is a tool result message - need to update the corresponding assistant message
          // Rebuild all messages with updated tool results
          const allAccumulated = accumulatedMessagesRef.current
          const newToolResultMap = buildToolResultMap(allAccumulated)

          setMessages(() => {
            const updatedMessages = allAccumulated
              .map((msg) => convertToMessage(msg, newToolResultMap))
              .filter((m): m is Message => m !== null)

            return updatedMessages
          })
        }
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

      // Add user message immediately to UI (optimistic update)
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: Date.now(),
        isOptimistic: true,  // Mark as temporary
      }
      setMessages((prev) => [...prev, userMessage])

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
        // Clear error after 5 seconds
        setTimeout(() => setError(null), 5000)
      }
    },
    [sessionId]
  )

  // Handle permission decision (placeholder for future implementation)
  const handlePermissionDecision = useCallback(
    (decision: PermissionDecision) => {
      // TODO: Implement permission handling via HTTP
      console.log('Permission decision:', decision)
      setPendingPermission(null)
    },
    []
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
    <div className="flex h-full flex-col bg-background">
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
          <MessageList messages={messages} />

          {/* Work-in-Progress Indicator - show when Claude is working (before result message) */}
          {isWorking && (
            <div className="px-4 py-2 border-t border-border">
              <ClaudeWIP
                text={
                  activeTodos.find((t) => t.status === 'in_progress')?.activeForm ||
                  progressMessage ||
                  'Working...'
                }
              />
            </div>
          )}

          <ChatInput onSend={sendMessage} />
        </div>

        {/* Todo Panel (collapsible) */}
        {activeTodos.length > 0 && (
          <TodoPanel todos={activeTodos} />
        )}
      </div>

      {/* Permission Modal */}
      {pendingPermission && (
        <PermissionModal
          request={pendingPermission}
          onDecision={handlePermissionDecision}
        />
      )}

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
