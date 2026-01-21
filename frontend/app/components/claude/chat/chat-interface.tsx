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
  filterConversationMessages,
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
  type SessionMessage,
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
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [wsConnected, setWsConnected] = useState(false)

  // Tool state - kept for future implementation
  const [activeTodos, setActiveTodos] = useState<TodoItem[]>([])
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<UserQuestion | null>(null)

  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null)

  // Convert SessionMessage to Message format
  const convertToMessage = (sessionMsg: SessionMessage): Message | null => {
    // Skip internal events (summaries, tool_results, etc.)
    if (!sessionMsg.message || (sessionMsg.type !== 'user' && sessionMsg.type !== 'assistant')) {
      return null
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

      // Extract tool calls from tool_use blocks
      toolCalls = content
        .filter(isToolUseBlock)
        .map((block): ToolCall => ({
          id: block.id,
          name: block.name as ToolCall['name'],
          parameters: block.input,
          status: 'completed',
        }))
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

  // Load history on mount and convert to Message format (initial load only)
  useEffect(() => {
    console.log('[ChatInterface] Loading history for session:', sessionId)
    if (historyMessages.length > 0) {
      const conversationMessages = filterConversationMessages(historyMessages)
      const converted = conversationMessages
        .map(convertToMessage)
        .filter((m): m is Message => m !== null)
      setMessages(converted)
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
          setIsStreaming(false)
          return
        }

        // Handle todo updates
        if (data.type === 'todo_update') {
          const todos: TodoItem[] = data.data?.todos || []
          setActiveTodos(todos)
          console.log('[ChatInterface] Received todo update:', todos)
          return
        }

        // Handle SessionMessage format
        const sessionMsg: SessionMessage = data
        console.log('[ChatInterface] Received message:', sessionMsg.type, sessionMsg.uuid)

        // Convert to Message format and append
        const converted = convertToMessage(sessionMsg)
        if (converted) {
          setMessages((prev) => {
            // Check if message already exists (by uuid)
            if (prev.some((m) => m.id === converted.id)) {
              return prev
            }
            return [...prev, converted]
          })

          // If we received an assistant message, stop streaming indicator
          if (converted.role === 'assistant') {
            setIsStreaming(false)
          }
        }
      } catch (error) {
        console.error('[ChatInterface] Failed to parse WebSocket message:', error)
        setIsStreaming(false)
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

      setIsStreaming(true)

      // Add user message immediately to UI (optimistic update)
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: Date.now(),
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
        // TODO: Show error to user
        setIsStreaming(false)
      }
      // Note: setIsStreaming(false) will happen when we receive the assistant's response
      // via WebSocket, or we can add a timeout
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
      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Messages */}
        <div className="flex flex-1 flex-col">
          <MessageList
            messages={messages}
            streamingContent={isStreaming ? streamingContent : undefined}
          />

          {/* Work-in-Progress Indicator */}
          {activeTodos.some((t) => t.status === 'in_progress') && (
            <div className="px-4 py-2 border-t border-border">
              <ClaudeWIP
                text={activeTodos.find((t) => t.status === 'in_progress')?.activeForm || 'Working...'}
              />
            </div>
          )}

          {/* Chat Input - always enabled */}
          <ChatInput
            onSend={sendMessage}
            disabled={isStreaming}
            placeholder={
              isStreaming
                ? 'Claude is thinking...'
                : 'Type a message...'
            }
          />
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
