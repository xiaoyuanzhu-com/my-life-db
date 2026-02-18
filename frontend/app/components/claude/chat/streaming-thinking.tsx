import { useMemo, useRef, useEffect, useState } from 'react'
import { parseMarkdownSync } from '~/lib/markdown'
import { MessageDot } from './message-dot'

interface StreamingThinkingProps {
  /** The accumulated streaming thinking text so far */
  text: string
}

/**
 * StreamingThinking - Displays Claude's thinking as it streams in
 *
 * Renders as a collapsible block matching the completed ThinkingBlockItem style:
 * - Default: collapsed, showing "Thinking..." with animated indicator
 * - Expandable: click to reveal accumulated thinking text
 * - Uses parseMarkdownSync for immediate rendering (same as StreamingResponse)
 * - Shows blinking cursor when expanded (indicates ongoing thinking)
 */
export function StreamingThinking({ text }: StreamingThinkingProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  // Track stable vs new text for fade-in animation (same pattern as StreamingResponse)
  const [stableText, setStableText] = useState('')
  const stabilizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Parse stable portion
  const stableHtml = useMemo(() => {
    if (!stableText) return ''
    return parseMarkdownSync(stableText)
  }, [stableText])

  // Parse new portion (will be animated)
  const newText = text.slice(stableText.length)
  const newHtml = useMemo(() => {
    if (!newText) return ''
    return parseMarkdownSync(newText)
  }, [newText])

  // Stabilize new content after animation completes
  useEffect(() => {
    if (stabilizeTimerRef.current) {
      clearTimeout(stabilizeTimerRef.current)
    }

    if (text.length > stableText.length) {
      stabilizeTimerRef.current = setTimeout(() => {
        setStableText(text)
      }, 150)
    }

    return () => {
      if (stabilizeTimerRef.current) {
        clearTimeout(stabilizeTimerRef.current)
      }
    }
  }, [text, stableText.length])

  // Reset stable text when text is cleared
  useEffect(() => {
    if (!text) {
      setStableText('')
    }
  }, [text])

  if (!text) return null

  return (
    <div className="mb-4 my-2">
      {/* Collapsible header: dot + "Thinking..." + chevron */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="font-mono text-[13px] leading-[1.5] flex items-start gap-2 w-full text-left hover:opacity-80 transition-opacity cursor-pointer"
      >
        <MessageDot status="in_progress" lineHeight="mono" />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span
            className="italic"
            style={{ color: 'var(--claude-text-secondary)' }}
          >
            Thinking
          </span>
          <span
            className="select-none text-[11px]"
            style={{ color: 'var(--claude-text-tertiary)' }}
          >
            {isExpanded ? '\u25BE' : '\u25B8'}
          </span>
        </div>
      </button>

      {/* Expanded content - rendered as markdown with smooth collapse */}
      <div className={`collapsible-grid ${isExpanded ? '' : 'collapsed'}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-2 ml-5 p-4 rounded-md prose-claude overflow-y-auto"
            style={{
              backgroundColor: 'var(--claude-bg-code-block)',
              maxHeight: '60vh',
            }}
          >
            {/* Stable content - no animation */}
            {stableHtml && (
              <span dangerouslySetInnerHTML={{ __html: stableHtml }} />
            )}
            {/* New content - fade+blur animation */}
            {newHtml && (
              <span
                key={stableText.length}
                className="animate-stream-word"
                dangerouslySetInnerHTML={{ __html: newHtml }}
              />
            )}
            {/* Blinking cursor */}
            <span
              className="inline-block w-[2px] h-[1em] align-middle animate-blink ml-0.5"
              style={{ backgroundColor: 'var(--claude-text-primary)' }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
