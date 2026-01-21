import { useState, useEffect, useCallback } from 'react'
import { MessageList } from './message-list'
import { ChatInput } from './chat-input'
import { TodoPanel } from './todo-panel'
import { PermissionModal } from './permission-modal'
import { AskUserQuestion } from './ask-user-question'
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
  isToolUseBlock,
  type SessionMessage,
} from '~/hooks/use-claude-session-history'

interface ChatInterfaceProps {
  sessionId: string
  sessionName?: string
  workingDir?: string
  onSessionNameChange?: (name: string) => void
  isHistorical?: boolean
}

export function ChatInterface({
  sessionId,
  isHistorical = false,
}: ChatInterfaceProps) {
  // Load structured history from JSONL files
  const { messages: historyMessages, isLoading: historyLoading, error: historyError, refetch } = useClaudeSessionHistory(sessionId)

  // Message state
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')

  // Tool state - kept for future implementation
  const [activeTodos, setActiveTodos] = useState<TodoItem[]>([])
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<UserQuestion | null>(null)

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
        .filter(block => block.type === 'thinking')
        .map(block => ({
          type: 'thinking' as const,
          thinking: (block as any).thinking || '',
          signature: (block as any).signature,
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

  // Auto-refresh history every 2 seconds when session is active
  useEffect(() => {
    if (isHistorical) return // Don't poll for historical sessions

    const interval = setInterval(() => {
      refetch()
    }, 2000)

    return () => clearInterval(interval)
  }, [isHistorical, refetch])

  // Send message to server via HTTP POST
  const sendMessage = useCallback(
    async (content: string) => {
      setIsStreaming(true)

      // Add user message immediately to UI
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: Date.now(),
      }
      setMessages((prev) => [...prev, userMessage])

      try {
        // Send message via HTTP POST
        const response = await fetch(`/api/claude/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        })

        if (!response.ok) {
          throw new Error(`Failed to send message: ${response.statusText}`)
        }

        // Trigger immediate refetch to get Claude's response
        // Don't wait for the 2-second polling interval
        refetch()
      } catch (error) {
        console.error('Failed to send message:', error)
        // TODO: Show error to user
      } finally {
        setIsStreaming(false)
      }
    },
    [sessionId, refetch]
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

          {/* Chat Input - always enabled */}
          <ChatInput
            onSend={sendMessage}
            disabled={isStreaming}
            placeholder={
              isStreaming
                ? 'Claude is thinking...'
                : isHistorical
                  ? 'Type a message to resume this session...'
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
