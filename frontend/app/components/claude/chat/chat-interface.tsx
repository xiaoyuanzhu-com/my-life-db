import { useState, useEffect, useRef, useCallback } from 'react'
import { MessageList } from './message-list'
import { ChatInput } from './chat-input'
import { SessionHeader } from './session-header'
import { TodoPanel } from './todo-panel'
import { PermissionModal } from './permission-modal'
import { AskUserQuestion } from './ask-user-question'
import type {
  Message,
  ToolCall,
  TodoItem,
  PermissionRequest,
  UserQuestion,
  WSMessage,
  PermissionDecision,
} from '~/types/claude'
import { useClaudeSessionHistory, filterConversationMessages, type SessionMessage } from '~/hooks/use-claude-session-history'

interface ChatInterfaceProps {
  sessionId: string
  sessionName?: string
  workingDir?: string
  onSessionNameChange?: (name: string) => void
}

export function ChatInterface({
  sessionId,
  sessionName = 'New Conversation',
  workingDir = '',
  onSessionNameChange,
}: ChatInterfaceProps) {
  // Load structured history from JSONL files
  const { messages: historyMessages, isLoading: historyLoading, error: historyError } = useClaudeSessionHistory(sessionId)

  // Message state
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')

  // Tool state
  const [activeTodos, setActiveTodos] = useState<TodoItem[]>([])
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<UserQuestion | null>(null)

  // Connection state
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | undefined>(undefined)

  // Token usage
  const [tokenUsage, setTokenUsage] = useState({ used: 0, limit: 200000 })

  // Convert SessionMessage to Message format
  const convertToMessage = (sessionMsg: SessionMessage): Message | null => {
    // Skip internal events
    if (!sessionMsg.message || (sessionMsg.type !== 'user' && sessionMsg.type !== 'assistant')) {
      return null
    }

    const content = Array.isArray(sessionMsg.message.content) ? sessionMsg.message.content : []
    const textBlocks = content.filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n')
    const toolCalls = content
      .filter(c => c.type === 'tool_use')
      .map((c): ToolCall => ({
        id: c.id || crypto.randomUUID(),
        name: c.name || 'unknown',
        input: c.input || {},
        status: 'completed',
      }))

    return {
      id: sessionMsg.uuid,
      role: sessionMsg.message.role || 'user',
      content: textBlocks,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      timestamp: new Date(sessionMsg.timestamp).getTime(),
    }
  }

  // Load history on mount and convert to Message format
  useEffect(() => {
    if (historyMessages.length > 0) {
      const conversationMessages = filterConversationMessages(historyMessages)
      const converted = conversationMessages
        .map(convertToMessage)
        .filter((m): m is Message => m !== null)
      setMessages(converted)
    }
  }, [historyMessages])

  // Connect to WebSocket
  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/claude/sessions/${sessionId}/chat`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('connected')
    }

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data)
        handleMessage(msg)
      } catch (e) {
        console.error('Failed to parse message:', e)
      }
    }

    ws.onerror = () => {
      setStatus('disconnected')
    }

    ws.onclose = () => {
      setStatus('disconnected')
      // Attempt reconnect after 2 seconds
      reconnectTimeoutRef.current = window.setTimeout(() => {
        if (wsRef.current?.readyState !== WebSocket.OPEN) {
          setStatus('connecting')
          connect()
        }
      }, 2000)
    }
  }, [sessionId])

  // Handle incoming WebSocket messages
  // NOTE: Chat UI uses structured history from JSONL files, not WebSocket
  // WebSocket only handles real-time interactive events
  const handleMessage = (msg: WSMessage) => {
    switch (msg.type) {
      case 'connected':
        // Session connected
        break

      case 'text_delta':
      case 'text_complete':
      case 'tool_use':
      case 'tool_result':
        // SKIP: Chat interface uses structured history from JSONL files via API
        // For raw terminal output, use the Terminal tab (xterm.js component)
        break

      case 'permission_request':
        setPendingPermission(msg.data as PermissionRequest)
        break

      case 'user_question':
        setPendingQuestion(msg.data as UserQuestion)
        break

      case 'todo_update':
        setActiveTodos((msg.data as { todos: TodoItem[] }).todos)
        break

      case 'session_update':
        const update = msg.data as { tokenUsage?: { used: number; limit: number } }
        if (update.tokenUsage) {
          setTokenUsage(update.tokenUsage)
        }
        break

      case 'error':
        console.error('Server error:', msg.data)
        break
    }
  }

  // Send message to server
  const sendMessage = useCallback(
    (content: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.error('WebSocket not connected')
        return
      }

      // Add user message immediately
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: Date.now(),
      }
      setMessages((prev) => [...prev, userMessage])

      // Send to server
      wsRef.current.send(
        JSON.stringify({
          type: 'user_message',
          content,
        })
      )
    },
    []
  )

  // Handle permission decision
  const handlePermissionDecision = useCallback(
    (decision: PermissionDecision) => {
      if (!pendingPermission || !wsRef.current) return

      wsRef.current.send(
        JSON.stringify({
          type: 'permission_decision',
          requestId: pendingPermission.id,
          decision,
        })
      )
      setPendingPermission(null)
    },
    [pendingPermission]
  )

  // Handle question answer
  const handleQuestionAnswer = useCallback(
    (answers: Record<string, string | string[]>) => {
      if (!pendingQuestion || !wsRef.current) return

      wsRef.current.send(
        JSON.stringify({
          type: 'question_answer',
          questionId: pendingQuestion.id,
          answers,
        })
      )
      setPendingQuestion(null)
    },
    [pendingQuestion]
  )

  // Connect on mount
  useEffect(() => {
    connect()

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [connect])

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Session Header */}
      <SessionHeader
        sessionName={sessionName}
        workingDir={workingDir}
        status={status}
        tokenUsage={tokenUsage}
        onNameChange={onSessionNameChange}
      />

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Messages */}
        <div className="flex flex-1 flex-col">
          <MessageList
            messages={messages}
            streamingContent={isStreaming ? streamingContent : undefined}
          />

          {/* Chat Input */}
          <ChatInput
            onSend={sendMessage}
            disabled={status !== 'connected' || isStreaming}
            placeholder={
              status !== 'connected'
                ? 'Connecting...'
                : isStreaming
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
