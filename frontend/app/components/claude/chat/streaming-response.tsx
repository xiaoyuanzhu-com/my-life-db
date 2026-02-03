interface StreamingResponseProps {
  /** The accumulated streaming text so far */
  text: string
  /** Optional className for styling */
  className?: string
}

/**
 * StreamingResponse - Displays Claude's response as it streams in
 *
 * Shows the accumulated text with a blinking cursor at the end,
 * matching the industry-standard UX (ChatGPT, Claude.ai, etc.).
 * Styled to match the assistant message bubble.
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
          {text}
          <span
            className="inline-block w-[2px] h-[1.1em] ml-0.5 align-middle animate-blink"
            style={{ backgroundColor: 'var(--claude-text-primary)' }}
          />
        </div>
      </div>
    </div>
  )
}
