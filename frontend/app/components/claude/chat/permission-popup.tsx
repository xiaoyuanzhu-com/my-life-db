import { useEffect, useCallback } from 'react'
import type { PermissionRequest, PermissionDecision } from '~/types/claude'

interface PermissionPopupProps {
  request: PermissionRequest
  onDecision: (decision: PermissionDecision) => void
}

/**
 * PermissionPopup - Inline permission request UI
 *
 * Appears above the chat input when Claude needs permission to use a tool.
 * Based on the Claude Code CLI permission UI design.
 *
 * Keyboard shortcuts:
 * - Esc: Deny
 * - Enter: Allow once
 * - Cmd/Ctrl+Enter: Always allow for session
 */
export function PermissionPopup({ request, onDecision }: PermissionPopupProps) {
  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onDecision('deny')
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onDecision('allowSession')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onDecision('allow')
      }
    },
    [onDecision]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

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

  // Truncate very long commands for display in header
  const truncatedPreview =
    previewText.length > 100 ? previewText.slice(0, 100) + '...' : previewText

  return (
    <div className="pb-2 claude-bg">
      <div className="max-w-3xl mx-auto px-6">
        <div
          className="rounded-xl border border-border overflow-hidden"
          style={{ backgroundColor: 'var(--claude-bg-subtle)' }}
        >
          {/* Header: Allow Claude to {Action} {preview}? */}
          <div className="px-4 pt-4 pb-2">
            <div className="text-[15px] leading-relaxed text-foreground">
              Allow Claude to{' '}
              <span className="font-semibold">{actionVerb}</span>{' '}
              <span className="font-mono text-[13px]">{truncatedPreview}</span>
              ?
            </div>

            {/* Description (if available) */}
            {description && (
              <div className="mt-1 text-[13px] text-muted-foreground">
                {description}
              </div>
            )}
          </div>

          {/* Command preview block */}
          <div className="mx-4 mb-3">
            <div
              className="rounded-lg border border-border p-3 font-mono text-[13px] text-foreground overflow-x-auto"
              style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
            >
              <pre className="whitespace-pre-wrap break-all">{previewText}</pre>
            </div>
          </div>

          {/* Action buttons */}
          <div
            className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border"
            style={{ backgroundColor: 'var(--claude-bg-canvas)' }}
          >
            {/* Deny */}
            <button
              onClick={() => onDecision('deny')}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-[13px] text-foreground hover:bg-muted transition-colors"
            >
              Deny
              <kbd className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[11px] font-mono">
                Esc
              </kbd>
            </button>

            {/* Always allow for session */}
            <button
              onClick={() => onDecision('allowSession')}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted text-[13px] text-foreground hover:bg-muted/80 transition-colors"
            >
              Always allow for session
              <kbd className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-background text-muted-foreground text-[11px] font-mono">
                <span>⌘</span>
                <span>⏎</span>
              </kbd>
            </button>

            {/* Allow once */}
            <button
              onClick={() => onDecision('allow')}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-[13px] text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Allow once
              <kbd className="px-1.5 py-0.5 rounded bg-primary-foreground/20 text-primary-foreground text-[11px] font-mono">
                ⏎
              </kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
