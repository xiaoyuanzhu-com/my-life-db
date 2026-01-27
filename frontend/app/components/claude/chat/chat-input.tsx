import { useState, useRef, KeyboardEvent, useEffect, useCallback } from 'react'
import { ArrowUp, Image } from 'lucide-react'
import { cn } from '~/lib/utils'
import type { PermissionRequest, PermissionDecision } from '~/types/claude'

interface ChatInputProps {
  onSend: (content: string) => void
  disabled?: boolean
  placeholder?: string
  /** Pending permission request - renders approval UI integrated into the input */
  pendingPermission?: PermissionRequest | null
  /** Callback when user makes a permission decision */
  onPermissionDecision?: (decision: PermissionDecision) => void
}

export function ChatInput({
  onSend,
  disabled = false,
  placeholder = 'Reply...',
  pendingPermission,
  onPermissionDecision,
}: ChatInputProps) {
  const [content, setContent] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const hasPermission = !!pendingPermission

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

  // Handle permission keyboard shortcuts
  const handlePermissionKeyDown = useCallback(
    (e: globalThis.KeyboardEvent) => {
      if (!hasPermission || !onPermissionDecision) return

      if (e.key === 'Escape') {
        e.preventDefault()
        onPermissionDecision('deny')
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onPermissionDecision('allowSession')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onPermissionDecision('allow')
      }
    },
    [hasPermission, onPermissionDecision]
  )

  useEffect(() => {
    if (hasPermission) {
      window.addEventListener('keydown', handlePermissionKeyDown)
      return () => window.removeEventListener('keydown', handlePermissionKeyDown)
    }
  }, [hasPermission, handlePermissionKeyDown])

  const handleAttachClick = () => {
    // TODO: Implement file attachment
    console.log('Attach file clicked')
  }

  return (
    <div className="pb-4 claude-bg">
      {/* Container matches message width */}
      <div className="max-w-3xl mx-auto px-6">
        {/* Input card - grows to include permission UI when needed */}
        <div
          className="border border-border rounded-xl overflow-hidden"
          style={{ backgroundColor: 'var(--claude-bg-subtle)' }}
        >
          {/* Permission approval section (when pending) */}
          {hasPermission && pendingPermission && (
            <PermissionSection
              request={pendingPermission}
              onDecision={onPermissionDecision!}
            />
          )}

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
}

function PermissionSection({ request, onDecision }: PermissionSectionProps) {
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
    <div className="p-3">
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
          onClick={() => onDecision('deny')}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border text-[12px] text-foreground hover:bg-muted transition-colors cursor-pointer"
        >
          Deny
          <kbd className="px-1 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-mono">
            Esc
          </kbd>
        </button>

        {/* Always allow for session */}
        <button
          onClick={() => onDecision('allowSession')}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border text-[12px] text-foreground hover:bg-muted transition-colors cursor-pointer"
        >
          Always allow for session
          <kbd className="flex items-center gap-0.5 px-1 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-mono">
            <span>⌘</span>
            <span>⏎</span>
          </kbd>
        </button>

        {/* Allow once */}
        <button
          onClick={() => onDecision('allow')}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary text-[12px] text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
        >
          Allow once
          <kbd className="px-1 py-0.5 rounded bg-primary-foreground/20 text-primary-foreground text-[10px] font-mono">
            ⏎
          </kbd>
        </button>
      </div>
    </div>
  )
}
