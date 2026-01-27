import { useState, useRef, KeyboardEvent, useEffect, useCallback, useTransition } from 'react'
import { ArrowUp, Image } from 'lucide-react'
import { cn } from '~/lib/utils'
import type { PermissionRequest, PermissionDecision } from '~/types/claude'

interface ChatInputProps {
  onSend: (content: string) => void
  disabled?: boolean
  placeholder?: string
  /** Pending permission requests - renders approval UI integrated into the input */
  pendingPermissions?: PermissionRequest[]
  /** Callback when user makes a permission decision */
  onPermissionDecision?: (requestId: string, decision: PermissionDecision) => void
  /** Whether to hide the input on mobile (for scroll-based hiding) */
  hiddenOnMobile?: boolean
}

export function ChatInput({
  onSend,
  disabled = false,
  placeholder = 'Reply...',
  pendingPermissions = [],
  onPermissionDecision,
  hiddenOnMobile = false,
}: ChatInputProps) {
  const [content, setContent] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const hasPermission = pendingPermissions.length > 0

  // Auto-resize textarea as content grows
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [content])

  const handleSend = () => {
    const trimmed = content.trim()
    if (trimmed && !disabled && !hasPermission) {
      onSend(trimmed)
      setContent('')
      // Reset height after sending
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter (without Shift) - only if no permission pending
    if (e.key === 'Enter' && !e.shiftKey && !hasPermission) {
      e.preventDefault()
      handleSend()
    }
    // Shift+Enter: allow default behavior (add newline)
  }

  const handleAttachClick = () => {
    // TODO: Implement file attachment
    console.log('Attach file clicked')
  }

  // Whether to actually hide (respects permission override)
  const shouldHide = hiddenOnMobile && !hasPermission

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
          {/* Permission approval section (when pending) - stacked for multiple */}
          {pendingPermissions.map((request, index) => (
            <PermissionSection
              key={request.requestId}
              request={request}
              onDecision={(decision) => onPermissionDecision!(request.requestId, decision)}
              isFirst={index === 0}
            />
          ))}

          {/* Input section */}
          <div className={cn('px-3 py-2', hasPermission && 'border-t border-border')}>
            {/* Text input */}
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={hasPermission ? 'Waiting for permission...' : placeholder}
              disabled={disabled || hasPermission}
              rows={1}
              className={cn(
                'w-full resize-none',
                'text-[15px] text-foreground',
                'placeholder:text-muted-foreground',
                'bg-transparent border-none outline-none',
                'disabled:cursor-not-allowed disabled:opacity-50',
                'min-h-[24px]'
              )}
            />

            {/* Actions row */}
            <div className="flex items-center justify-between mt-2">
              {/* Attachment icon - left */}
              <button
                type="button"
                onClick={handleAttachClick}
                disabled={disabled || hasPermission}
                className={cn(
                  'text-muted-foreground hover:text-foreground',
                  'transition-colors',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
                aria-label="Attach file"
              >
                <Image className="h-5 w-5" />
              </button>

              {/* Submit button - right */}
              <button
                type="button"
                onClick={handleSend}
                disabled={disabled || hasPermission || !content.trim()}
                className={cn(
                  'h-9 w-9 rounded-lg',
                  'bg-primary hover:bg-primary/80',
                  'flex items-center justify-center',
                  'transition-all',
                  'disabled:cursor-not-allowed',
                  !content.trim() || hasPermission ? 'opacity-40' : 'opacity-100'
                )}
                aria-label="Send message"
              >
                <ArrowUp className="h-4 w-4 text-primary-foreground" strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Permission Section (integrated into input card)
// ============================================================================

interface PermissionSectionProps {
  request: PermissionRequest
  onDecision: (decision: PermissionDecision) => void
  /** Whether this is the first (topmost) permission - receives keyboard shortcuts */
  isFirst?: boolean
}

function PermissionSection({ request, onDecision, isFirst = true }: PermissionSectionProps) {
  const [isDismissing, setIsDismissing] = useState(false)
  const [pendingDecision, setPendingDecision] = useState<PermissionDecision | null>(null)

  // Handle button click - start exit animation
  const handleDecision = useCallback((decision: PermissionDecision) => {
    if (isDismissing) return // Prevent double-click
    setIsDismissing(true)
    setPendingDecision(decision)
  }, [isDismissing])

  // After animation ends, call the actual decision handler
  const handleAnimationEnd = () => {
    if (isDismissing && pendingDecision) {
      onDecision(pendingDecision)
    }
  }

  // Handle keyboard shortcuts - only for the first (topmost) permission
  useEffect(() => {
    if (!isFirst) return

    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (isDismissing) return

      if (e.key === 'Escape') {
        e.preventDefault()
        handleDecision('deny')
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleDecision('allowSession')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleDecision('allow')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isFirst, isDismissing, handleDecision])

  // Get the action verb based on tool name
  const getActionVerb = (toolName: string): string => {
    switch (toolName) {
      case 'Bash':
        return 'Run'
      case 'Read':
        return 'Read'
      case 'Write':
        return 'Write'
      case 'Edit':
        return 'Edit'
      case 'WebFetch':
        return 'Fetch'
      case 'WebSearch':
        return 'Search'
      default:
        return 'Use'
    }
  }

  // Get the preview text based on tool and input
  const getPreviewText = (toolName: string, input: Record<string, unknown>): string => {
    switch (toolName) {
      case 'Bash':
        return (input.command as string) || ''
      case 'Read':
      case 'Write':
      case 'Edit':
        return (input.file_path as string) || ''
      case 'WebFetch':
        return (input.url as string) || ''
      case 'WebSearch':
        return (input.query as string) || ''
      default:
        return JSON.stringify(input, null, 2)
    }
  }

  // Get the description if available
  const getDescription = (input: Record<string, unknown>): string | null => {
    return (input.description as string) || null
  }

  const actionVerb = getActionVerb(request.toolName)
  const previewText = getPreviewText(request.toolName, request.input)
  const description = getDescription(request.input)

  return (
    <div
      className={cn(
        'p-3',
        isDismissing ? 'animate-slide-down-fade' : 'animate-slide-up-fade',
        !isFirst && 'border-t border-border'
      )}
      onAnimationEnd={handleAnimationEnd}
    >
      {/* Header: Allow Claude to {Action}? */}
      <div className="text-[14px] leading-relaxed text-foreground mb-2">
        Allow Claude to <span className="font-semibold">{actionVerb}</span>?
      </div>

      {/* Description (if available) */}
      {description && (
        <div className="text-[12px] text-muted-foreground mb-2">{description}</div>
      )}

      {/* Command/query preview block */}
      <div
        className="rounded-lg border border-border p-2 font-mono text-[12px] text-foreground overflow-x-auto mb-3 max-h-32 overflow-y-auto"
        style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
      >
        <pre className="whitespace-pre-wrap break-all">{previewText}</pre>
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2">
        {/* Deny */}
        <button
          onClick={() => handleDecision('deny')}
          disabled={isDismissing}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border text-[12px] text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50"
        >
          Deny
          {isFirst && (
            <kbd className="px-1 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-mono">
              Esc
            </kbd>
          )}
        </button>

        {/* Always allow for session */}
        <button
          onClick={() => handleDecision('allowSession')}
          disabled={isDismissing}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border text-[12px] text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50"
        >
          Always allow for session
          {isFirst && (
            <kbd className="flex items-center gap-0.5 px-1 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-mono">
              <span>⌘</span>
              <span>⏎</span>
            </kbd>
          )}
        </button>

        {/* Allow once */}
        <button
          onClick={() => handleDecision('allow')}
          disabled={isDismissing}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary text-[12px] text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
        >
          Allow once
          {isFirst && (
            <kbd className="px-1 py-0.5 rounded bg-primary-foreground/20 text-primary-foreground text-[10px] font-mono">
              ⏎
            </kbd>
          )}
        </button>
      </div>
    </div>
  )
}
