import { useMemo } from 'react'
import { parseMarkdownSync } from '~/lib/shiki'
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
 */
export function StreamingResponse({ text, className = '' }: StreamingResponseProps) {
  const html = useMemo(() => {
    if (!text) return ''
    return parseMarkdownSync(text)
  }, [text])

  if (!text) return null

  return (
    <div className={`flex gap-2 ${className}`}>
      <MessageDot status="in_progress" lineHeight="prose" />
      <div className="flex-1 min-w-0">
        <div
          className="prose-claude"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <span
          className="inline-block w-[2px] h-[1em] align-middle animate-blink"
          style={{ backgroundColor: 'var(--claude-text-primary)' }}
        />
      </div>
    </div>
  )
}
