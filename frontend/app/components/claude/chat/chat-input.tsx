import { useImperativeHandle, forwardRef, useCallback } from 'react'
import { cn } from '~/lib/utils'
import type { PermissionRequest, PermissionDecision, UserQuestion } from '~/types/claude'
import { useDraftPersistence, useReconnectionFeedback, type ConnectionStatus } from './hooks'
import { ConnectionStatusBanner } from './connection-status-banner'
import { PermissionCard } from './permission-card'
import { QuestionCard } from './question-card'
import { ChatInputField } from './chat-input-field'

// Re-export ConnectionStatus for backwards compatibility
export type { ConnectionStatus }

/** Imperative handle for ChatInput - allows parent to manage draft lifecycle */
export interface ChatInputHandle {
  /** Clear the draft from localStorage (call when message confirmed sent) */
  clearDraft: () => void
  /** Restore content from localStorage (call on send failure) */
  restoreDraft: () => void
  /** Get current draft content from localStorage */
  getDraft: () => string | null
}

interface ChatInputProps {
  /** Session ID for localStorage key namespacing */
  sessionId: string
  onSend: (content: string) => void
  disabled?: boolean
  placeholder?: string
  /** Pending permission requests - renders approval UI integrated into the input */
  pendingPermissions?: PermissionRequest[]
  /** Callback when user makes a permission decision */
  onPermissionDecision?: (requestId: string, decision: PermissionDecision) => void
  /** Pending user questions (from AskUserQuestion tool) - renders question UI integrated into the input */
  pendingQuestions?: UserQuestion[]
  /** Callback when user answers a question */
  onQuestionAnswer?: (questionId: string, answers: Record<string, string | string[]>) => void
  /** Callback when user skips a question */
  onQuestionSkip?: (questionId: string) => void
  /** Whether to hide the input on mobile (for scroll-based hiding) */
  hiddenOnMobile?: boolean
  /** Whether Claude is currently working (processing a request) */
  isWorking?: boolean
  /** Callback to interrupt the current operation */
  onInterrupt?: () => void
  /** WebSocket connection status */
  connectionStatus?: ConnectionStatus
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    sessionId,
    onSend,
    disabled = false,
    placeholder = 'Reply...',
    pendingPermissions = [],
    onPermissionDecision,
    pendingQuestions = [],
    onQuestionAnswer,
    onQuestionSkip,
    hiddenOnMobile = false,
    isWorking = false,
    onInterrupt,
    connectionStatus = 'connected',
  },
  ref
) {
  // Draft persistence hook
  const draft = useDraftPersistence(sessionId)

  // Reconnection feedback hook (needs sessionId to reset on session switch)
  const reconnection = useReconnectionFeedback(connectionStatus, sessionId)

  // Expose imperative handle for parent to manage draft lifecycle
  useImperativeHandle(
    ref,
    () => ({
      clearDraft: draft.clearDraft,
      restoreDraft: draft.restoreDraft,
      getDraft: draft.getDraft,
    }),
    [draft.clearDraft, draft.restoreDraft, draft.getDraft]
  )

  const hasPermission = pendingPermissions.length > 0
  const hasQuestion = pendingQuestions.length > 0
  const hasOverlay = hasPermission || hasQuestion // Input is blocked when permission or question pending

  // Handle send - mark pending, call parent, clear content
  const handleSend = useCallback(() => {
    const trimmed = draft.content.trim()
    if (trimmed && !disabled && !hasOverlay) {
      draft.markPendingSend()
      onSend(trimmed)
      draft.setContent('')
    }
  }, [draft, disabled, hasOverlay, onSend])

  // Whether to show connection status banner
  const showConnectionBanner =
    connectionStatus !== 'connected' || (reconnection.showReconnected && connectionStatus === 'connected')

  // Whether to actually hide (respects permission/question override)
  const shouldHide = hiddenOnMobile && !hasOverlay

  return (
    <div
      className={cn(
        'claude-bg overflow-hidden transition-all duration-200 ease-out',
        // On mobile, collapse height when hidden
        shouldHide ? 'max-md:max-h-0 max-md:pb-0' : 'pb-4'
      )}
    >
      {/* Container matches message width */}
      <div className="w-full max-w-4xl mx-auto px-4 md:px-6">
        {/* Input card - grows to include permission UI when needed */}
        <div
          className="border border-border rounded-xl overflow-hidden"
          style={{ backgroundColor: 'var(--claude-bg-subtle)' }}
        >
          {/* Connection status banner */}
          {showConnectionBanner && (
            <ConnectionStatusBanner
              status={connectionStatus}
              isReconnected={reconnection.showReconnected && connectionStatus === 'connected'}
              isDismissing={reconnection.isDismissing}
              onDismissed={reconnection.onDismissed}
            />
          )}

          {/* Permission approval section (when pending) - stacked for multiple */}
          {pendingPermissions.map((request, index) => (
            <PermissionCard
              key={request.requestId}
              request={request}
              onDecision={(decision) => onPermissionDecision!(request.requestId, decision)}
              isFirst={index === 0 && !hasQuestion}
            />
          ))}

          {/* User question section (when pending) - stacked for multiple */}
          {pendingQuestions.map((question, index) => (
            <QuestionCard
              key={question.id}
              question={question}
              onAnswer={(answers) => onQuestionAnswer!(question.id, answers)}
              onSkip={() => onQuestionSkip!(question.id)}
              isFirst={index === 0}
            />
          ))}

          {/* Input section */}
          <div className={cn(hasOverlay && 'border-t border-border')}>
            <ChatInputField
              content={draft.content}
              onChange={draft.setContent}
              onSend={handleSend}
              onInterrupt={onInterrupt}
              isWorking={isWorking}
              disabled={disabled}
              placeholder={hasOverlay ? 'Waiting for response...' : placeholder}
              hasPermission={hasOverlay}
            />
          </div>
        </div>
      </div>
    </div>
  )
})
