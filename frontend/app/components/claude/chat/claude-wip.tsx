import { useState, useEffect, useRef } from 'react'
import { MessageDot } from './message-dot'

interface ClaudeWIPProps {
  /** The task text to display (e.g., "Finagling...", "Reading files...") */
  text: string
  /** Turn counter — when this changes, pick fresh random words */
  turnId?: number
  /** Optional className for styling */
  className?: string
}

/** Fun words to randomly display when Claude is working */
const WORKING_WORDS = [
  'Accomplishing',
  'Actioning',
  'Actualizing',
  'Baking',
  'Booping',
  'Brewing',
  'Calculating',
  'Cerebrating',
  'Channelling',
  'Churning',
  'Clauding',
  'Coalescing',
  'Cogitating',
  'Combobulating',
  'Computing',
  'Concocting',
  'Conjuring',
  'Considering',
  'Contemplating',
  'Cooking',
  'Crafting',
  'Creating',
  'Crunching',
  'Deciphering',
  'Deliberating',
  'Determining',
  'Discombobulating',
  'Divining',
  'Doing',
  'Effecting',
  'Elucidating',
  'Enchanting',
  'Envisioning',
  'Finagling',
  'Flibbertigibbeting',
  'Forging',
  'Forming',
  'Frolicking',
  'Generating',
  'Germinating',
  'Hatching',
  'Herding',
  'Honking',
  'Hustling',
  'Ideating',
  'Imagining',
  'Incubating',
  'Inferring',
  'Jiving',
  'Manifesting',
  'Marinating',
  'Meandering',
  'Moseying',
  'Mulling',
  'Mustering',
  'Musing',
  'Noodling',
  'Percolating',
  'Perusing',
  'Philosophising',
  'Pondering',
  'Pontificating',
  'Processing',
  'Puttering',
  'Puzzling',
  'Reticulating',
  'Ruminating',
  'Scheming',
  'Schlepping',
  'Shimmying',
  'Shucking',
  'Simmering',
  'Smooshing',
  'Spelunking',
  'Spinning',
  'Stewing',
  'Sussing',
  'Synthesizing',
  'Thinking',
  'Tinkering',
  'Transmuting',
  'Unfurling',
  'Unravelling',
  'Vibing',
  'Wandering',
  'Whirring',
  'Wibbling',
  'Wizarding',
  'Working',
  'Wrangling',
]

const DEFAULT_WORKING_TEXT = 'Working...'
const ROTATE_WORD_COUNT = 5

/** Pick N random words from the list, each suffixed with "..." */
function pickRandomWords(count: number): string[] {
  const shuffled = [...WORKING_WORDS].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count).map((w) => `${w}...`)
}

/**
 * ClaudeWIP - Work-in-Progress indicator with typing effect
 *
 * Displays a text string with a pulsing orange dot and typing animation.
 * The text types out character by character.
 *
 * When the default "Working..." text is passed, randomly picks 5 fun words
 * and cycles through them — advancing to the next word when the current
 * word's typing animation completes. Words are picked once per turn (keyed
 * by turnId) so they stay consistent even when WIP hides/shows mid-turn.
 *
 * Example:
 * <ClaudeWIP text="Working..." turnId={3} />  // cycles random fun words
 * <ClaudeWIP text="Running tests..." />        // shows specific text
 */
export function ClaudeWIP({ text: rawText, turnId, className = '' }: ClaudeWIPProps) {
  // Ensure text is always a string
  const text = typeof rawText === 'string' ? rawText : ''
  const isDefaultWorking = text === DEFAULT_WORKING_TEXT

  const [words, setWords] = useState<string[]>([])
  const [wordIndex, setWordIndex] = useState(0)
  const [charIndex, setCharIndex] = useState(0)

  // Pick random words once per turn (when turnId changes)
  // This keeps words stable across WIP hide/show cycles within the same turn
  const prevTurnId = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (turnId !== prevTurnId.current) {
      setWords(pickRandomWords(ROTATE_WORD_COUNT))
      setWordIndex(0)
      setCharIndex(0)
      prevTurnId.current = turnId
    }
  }, [turnId])

  // Reset charIndex when specific (non-default) text changes
  useEffect(() => {
    if (!isDefaultWorking) {
      setCharIndex(0)
    }
  }, [text, isDefaultWorking])

  const displayText = isDefaultWorking ? (words[wordIndex] || DEFAULT_WORKING_TEXT) : text

  // Typing animation
  useEffect(() => {
    if (!displayText) return

    const isComplete = charIndex >= displayText.length

    if (isComplete) {
      if (isDefaultWorking) {
        // Pause at end, then advance to next word
        const timeout = setTimeout(() => {
          setWordIndex((prev) => (prev + 1) % ROTATE_WORD_COUNT)
          setCharIndex(0)
        }, 240)
        return () => clearTimeout(timeout)
      } else {
        // Original behavior: pause then restart typing
        const timeout = setTimeout(() => {
          setCharIndex(0)
        }, 240)
        return () => clearTimeout(timeout)
      }
    }

    const timeout = setTimeout(() => {
      setCharIndex((prev) => prev + 1)
    }, 120)

    return () => clearTimeout(timeout)
  }, [displayText, charIndex, isDefaultWorking])

  if (!text) return null

  return (
    <div className={`font-mono text-[13px] leading-[1.5] ${className}`}>
      <div className="flex items-start gap-2">
        <MessageDot status="in_progress" />
        <div className="flex-1 min-w-0">
          <span style={{ color: '#E07A5F' }}>{displayText.slice(0, charIndex)}</span>
        </div>
      </div>
    </div>
  )
}
