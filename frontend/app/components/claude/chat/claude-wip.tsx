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
 * Displays a text string with a blinking orange dot and typing animation.
 * The text types out character by character, then repeats.
 *
 * Example:
 * <ClaudeWIP text="Working..." />
 */
export function ClaudeWIP({ text, className = '' }: ClaudeWIPProps) {
  const [charIndex, setCharIndex] = useState(1)

  useEffect(() => {
    if (!text) return

    const interval = setInterval(() => {
      setCharIndex((prev) => (prev >= text.length ? 1 : prev + 1))
    }, 80)

    return () => clearInterval(interval)
  }, [text])

  useEffect(() => {
    setCharIndex(1)
  }, [text])

  if (!text) return null

  return (
    <div className={`flex gap-2 mb-4 ${className}`}>
      <MessageDot status="in_progress" lineHeight="prose" />
      <span
        className="text-[15px] leading-relaxed font-sans"
        style={{ color: '#E07A5F' }}
      >
        {text.slice(0, charIndex)}
      </span>
    </div>
  )
}
