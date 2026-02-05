import { useState, useEffect, useCallback } from 'react'
import { cn } from '~/lib/utils'
import { parseMarkdown } from '~/lib/markdown'
import type { PermissionRequest, PermissionDecision } from '~/types/claude'

interface PermissionCardProps {
  request: PermissionRequest
  onDecision: (decision: PermissionDecision) => void
  /** Whether this is the first (topmost) permission - receives keyboard shortcuts */
  isFirst?: boolean
}

/** Get the action verb based on tool name */
function getActionVerb(toolName: string): string {
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
    case 'ExitPlanMode':
      return 'Execute'
    default:
      return 'Use'
  }
}

/** Get the preview text based on tool and input */
function getPreviewText(toolName: string, input: Record<string, unknown>): string {
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

/** Get the description if available */
function getDescription(input: Record<string, unknown>): string | null {
  return (input.description as string) || null
}

export function PermissionCard({ request, onDecision, isFirst = true }: PermissionCardProps) {
  const [isDismissing, setIsDismissing] = useState(false)
  const [pendingDecision, setPendingDecision] = useState<PermissionDecision | null>(null)
  const [planHtml, setPlanHtml] = useState('')

  // Check if this is an ExitPlanMode request
  const isExitPlanMode = request.toolName === 'ExitPlanMode'
  const planContent = isExitPlanMode ? (request.input.plan as string) || '' : ''

  // Parse plan markdown for ExitPlanMode
  useEffect(() => {
    if (!isExitPlanMode || !planContent) {
      setPlanHtml('')
      return
    }

    let cancelled = false
    parseMarkdown(planContent).then((parsed) => {
      if (!cancelled) setPlanHtml(parsed)
    })

    return () => {
      cancelled = true
    }
  }, [isExitPlanMode, planContent])

  // Handle button click - start exit animation
  const handleDecision = useCallback(
    (decision: PermissionDecision) => {
      if (isDismissing) return // Prevent double-click
      setIsDismissing(true)
      setPendingDecision(decision)
    },
    [isDismissing]
  )

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
        Allow Claude to <span className="font-semibold">{actionVerb}</span>
        {isExitPlanMode ? ' below plan?' : '?'}
      </div>

      {/* Description (if available) */}
      {description && (
        <div className="text-[12px] text-muted-foreground mb-2">{description}</div>
      )}

      {/* Content block - markdown for ExitPlanMode, code block for others */}
      {isExitPlanMode ? (
        <div
          className="rounded-lg border border-border p-4 mb-3 max-h-96 overflow-y-auto prose-claude"
          style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
          dangerouslySetInnerHTML={{ __html: planHtml }}
        />
      ) : (
        <div
          className="rounded-lg border border-border p-2 font-mono text-[12px] text-foreground overflow-x-auto mb-3 max-h-32 overflow-y-auto"
          style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
        >
          <pre className="whitespace-pre-wrap break-all">{previewText}</pre>
        </div>
      )}

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
            <kbd className="hidden md:inline px-1 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-mono">
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
            <kbd className="hidden md:flex items-center gap-0.5 px-1 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-mono">
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
            <kbd className="hidden md:inline px-1 py-0.5 rounded bg-primary-foreground/20 text-primary-foreground text-[10px] font-mono">
              ⏎
            </kbd>
          )}
        </button>
      </div>
    </div>
  )
}
