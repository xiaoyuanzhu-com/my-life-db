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
 * Shows the accumulated text with a pulsing indicator to show more content
 * is being generated. Styled to match the assistant message bubble.
 */
export function StreamingResponse({ text, className = '' }: StreamingResponseProps) {
  if (!text) return null

  return (
    <div className={`mb-4 ${className}`}>
      <div className="flex flex-col items-start">
        <div
          className="inline-block max-w-[85%] px-4 py-3 rounded-xl text-[15px] leading-relaxed whitespace-pre-wrap break-words"
          style={{
            backgroundColor: 'var(--claude-bg-subtle)',
            color: 'var(--claude-text-primary)',
          }}
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              {text}
              <span className="inline-flex items-center ml-1">
                <MessageDot status="in_progress" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
