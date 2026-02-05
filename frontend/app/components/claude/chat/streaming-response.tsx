import { useMemo, useRef, useEffect, useState } from 'react'
import { parseMarkdownSync } from '~/lib/markdown'
import { MessageDot } from './message-dot'

interface StreamingResponseProps {
  /** The accumulated streaming text so far */
  text: string
  /** Optional className for styling */
  className?: string
}

/**
 * StreamingResponse - Displays Claude's response as it streams in
 *
 * Renders markdown as it arrives using the sync parser (no syntax highlighting).
 * Shows a blinking cursor at the end, matching industry-standard UX.
 *
 * UX Enhancement: New text "materializes" with a fade+blur animation.
 * Works by tracking stable (already animated) content vs new content,
 * and applying animation only to the new portion.
 */
export function StreamingResponse({ text, className = '' }: StreamingResponseProps) {
  // Track which portion of text has already been "stabilized" (animated)
  // After a short delay, new content becomes stable content
  const [stableText, setStableText] = useState('')
  const stabilizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Parse the stable portion (no animation)
  const stableHtml = useMemo(() => {
    if (!stableText) return ''
    return parseMarkdownSync(stableText)
  }, [stableText])

  // The new portion is text that hasn't been stabilized yet
  const newText = text.slice(stableText.length)

  // Parse the new portion (will be animated)
  const newHtml = useMemo(() => {
    if (!newText) return ''
    return parseMarkdownSync(newText)
  }, [newText])

  // When text changes, schedule stabilization of the new content
  // After 150ms (animation duration + buffer), mark new content as stable
  useEffect(() => {
    if (stabilizeTimerRef.current) {
      clearTimeout(stabilizeTimerRef.current)
    }

    // If there's new content, schedule it to become stable
    if (text.length > stableText.length) {
      stabilizeTimerRef.current = setTimeout(() => {
        setStableText(text)
      }, 150) // Matches animation duration (120ms) + small buffer
    }

    return () => {
      if (stabilizeTimerRef.current) {
        clearTimeout(stabilizeTimerRef.current)
      }
    }
  }, [text, stableText.length])

  // Reset stable text when text is cleared (new response starts)
  useEffect(() => {
    if (!text) {
      setStableText('')
    }
  }, [text])

  if (!text) return null

  return (
    <div className={`flex gap-2 ${className}`}>
      <MessageDot status="in_progress" lineHeight="prose" />
      <div className="flex-1 min-w-0">
        <div className="prose-claude">
          {/* Stable content - no animation */}
          {stableHtml && (
            <span dangerouslySetInnerHTML={{ __html: stableHtml }} />
          )}
          {/* New content - fade+blur animation */}
          {newHtml && (
            <span
              key={stableText.length} // Force re-mount to restart animation
              className="animate-stream-word"
              dangerouslySetInnerHTML={{ __html: newHtml }}
            />
          )}
        </div>
        <span
          className="inline-block w-[2px] h-[1em] align-middle animate-blink"
          style={{ backgroundColor: 'var(--claude-text-primary)' }}
        />
      </div>
    </div>
  )
}
