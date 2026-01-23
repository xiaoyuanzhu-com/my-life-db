import { MessageDot } from './message-dot'

interface ClaudeWIPProps {
  /** The task text to display (e.g., "Finagling...", "Reading files...") */
  text: string
  /** Optional className for styling */
  className?: string
}

/**
 * ClaudeWIP - Work-in-Progress indicator with blinking dot
 *
 * Displays a text string with a blinking orange dot, matching the official
 * Claude Code UI style. Renders in the same layout as message blocks.
 *
 * Example:
 * <ClaudeWIP text="Finagling..." />
 */
export function ClaudeWIP({ text, className = '' }: ClaudeWIPProps) {
  if (!text) return null

  return (
    <div className={`flex gap-2 mb-4 ${className}`}>
      <MessageDot status="in_progress" lineHeight="prose" />
      <span
        className="text-[15px] leading-relaxed font-sans"
        style={{ color: '#E07A5F' }}
      >
        {text}
      </span>
    </div>
  )
}
