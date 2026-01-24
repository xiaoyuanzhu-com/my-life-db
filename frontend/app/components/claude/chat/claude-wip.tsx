import { useState, useEffect } from 'react'
import { MessageDot } from './message-dot'

interface ClaudeWIPProps {
  /** The task text to display (e.g., "Finagling...", "Reading files...") */
  text: string
  /** Optional className for styling */
  className?: string
}

/**
 * ClaudeWIP - Work-in-Progress indicator with typing effect
 *
 * Displays a text string with a pulsing orange dot and typing animation.
 * The text types out character by character, then repeats.
 *
 * Example:
 * <ClaudeWIP text="Working..." />
 */
export function ClaudeWIP({ text: rawText, className = '' }: ClaudeWIPProps) {
  // Ensure text is always a string
  const text = typeof rawText === 'string' ? rawText : ''
  const [charIndex, setCharIndex] = useState(0)

  useEffect(() => {
    if (!text) return

    const isComplete = charIndex >= text.length
    const delay = isComplete ? 240 : 120 // Pause at end

    const timeout = setTimeout(() => {
      setCharIndex((prev) => (prev >= text.length ? 0 : prev + 1))
    }, delay)

    return () => clearTimeout(timeout)
  }, [text, charIndex])

  useEffect(() => {
    setCharIndex(0)
  }, [text])

  if (!text) return null

  return (
    <div className={`font-mono text-[13px] leading-[1.5] ${className}`}>
      <div className="flex items-start gap-2">
        <MessageDot status="in_progress" />
        <div className="flex-1 min-w-0">
          <span style={{ color: '#E07A5F' }}>{text.slice(0, charIndex)}</span>
        </div>
      </div>
    </div>
  )
}
