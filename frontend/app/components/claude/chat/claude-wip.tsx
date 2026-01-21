import { useState, useEffect } from 'react'

interface ClaudeWIPProps {
  /** The task text to display (e.g., "Finagling...", "Reading files...") */
  text: string
  /** Optional className for styling */
  className?: string
}

/**
 * ClaudeWIP - Work-in-Progress indicator with typing animation
 *
 * Displays a text string with a typewriter effect, similar to the official
 * Claude Code UI. The text cycles through showing characters with an ellipsis
 * animation to indicate ongoing work.
 *
 * Example:
 * <ClaudeWIP text="Finagling..." />
 *
 * The animation creates a typing effect where characters appear one by one,
 * then the text resets and types again, creating a continuous loop.
 */
export function ClaudeWIP({ text, className = '' }: ClaudeWIPProps) {
  const [displayText, setDisplayText] = useState('')
  const [charIndex, setCharIndex] = useState(0)

  useEffect(() => {
    // Reset animation when text changes
    setCharIndex(0)
    setDisplayText('')
  }, [text])

  useEffect(() => {
    // Typing animation logic
    if (charIndex < text.length) {
      const timeout = setTimeout(() => {
        setDisplayText(text.substring(0, charIndex + 1))
        setCharIndex(charIndex + 1)
      }, 100) // 100ms per character

      return () => clearTimeout(timeout)
    } else {
      // When fully typed, wait 1 second then restart
      const timeout = setTimeout(() => {
        setCharIndex(0)
        setDisplayText('')
      }, 1000)

      return () => clearTimeout(timeout)
    }
  }, [charIndex, text])

  if (!text) return null

  return (
    <div className={`flex items-center gap-2 text-sm text-muted-foreground ${className}`}>
      {/* Blinking dot indicator */}
      <div className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400/75"></span>
        <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500"></span>
      </div>

      {/* Typing text */}
      <span className="font-mono">
        {displayText}
        {/* Blinking cursor */}
        <span className="inline-block w-[2px] h-[1em] bg-current ml-[2px] animate-[blink_1s_ease-in-out_infinite]" />
      </span>
    </div>
  )
}
