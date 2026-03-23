/**
 * AgentWIP -- Work-in-Progress indicator shown when the agent is working.
 *
 * Matches the old Claude Code claude-wip.tsx pattern:
 * - Pulsing MessageDot (assistant-wip, orange)
 * - Random fun word cycling ("Clauding...", "Noodling...", "Spelunking...")
 * - Typing animation: character by character, 120ms per char
 */
import { useState, useEffect, useRef } from "react"
import { MessageDot } from "./message-dot"

interface AgentWIPProps {
  className?: string
}

/** Fun words to randomly display when the agent is working */
const WORKING_WORDS = [
  "Accomplishing",
  "Actioning",
  "Baking",
  "Booping",
  "Brewing",
  "Calculating",
  "Cerebrating",
  "Channelling",
  "Churning",
  "Clauding",
  "Coalescing",
  "Cogitating",
  "Combobulating",
  "Computing",
  "Concocting",
  "Conjuring",
  "Considering",
  "Contemplating",
  "Cooking",
  "Crafting",
  "Creating",
  "Crunching",
  "Deciphering",
  "Deliberating",
  "Determining",
  "Discombobulating",
  "Divining",
  "Doing",
  "Effecting",
  "Elucidating",
  "Enchanting",
  "Envisioning",
  "Finagling",
  "Flibbertigibbeting",
  "Forging",
  "Frolicking",
  "Generating",
  "Germinating",
  "Hatching",
  "Herding",
  "Honking",
  "Hustling",
  "Ideating",
  "Imagining",
  "Incubating",
  "Inferring",
  "Jiving",
  "Manifesting",
  "Marinating",
  "Meandering",
  "Moseying",
  "Mulling",
  "Mustering",
  "Musing",
  "Noodling",
  "Percolating",
  "Perusing",
  "Philosophising",
  "Pondering",
  "Pontificating",
  "Processing",
  "Puttering",
  "Puzzling",
  "Reticulating",
  "Ruminating",
  "Scheming",
  "Schlepping",
  "Shimmying",
  "Shucking",
  "Simmering",
  "Smooshing",
  "Spelunking",
  "Spinning",
  "Stewing",
  "Sussing",
  "Synthesizing",
  "Thinking",
  "Tinkering",
  "Transmuting",
  "Unfurling",
  "Unravelling",
  "Vibing",
  "Wandering",
  "Whirring",
  "Wibbling",
  "Wizarding",
  "Working",
  "Wrangling",
]

const ROTATE_WORD_COUNT = 5

/** Pick N random words from the list, each suffixed with "..." */
function pickRandomWords(count: number): string[] {
  const shuffled = [...WORKING_WORDS].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count).map((w) => `${w}...`)
}

export function AgentWIP({ className = "" }: AgentWIPProps) {
  const [words] = useState<string[]>(() => pickRandomWords(ROTATE_WORD_COUNT))
  const [wordIndex, setWordIndex] = useState(0)
  const [charIndex, setCharIndex] = useState(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const displayText = words[wordIndex] || "Working..."

  // Typing animation
  useEffect(() => {
    if (!displayText) return

    const isComplete = charIndex >= displayText.length

    if (isComplete) {
      // Pause at end, then advance to next word
      const timeout = setTimeout(() => {
        if (!mountedRef.current) return
        setWordIndex((prev) => (prev + 1) % ROTATE_WORD_COUNT)
        setCharIndex(0)
      }, 240)
      return () => clearTimeout(timeout)
    }

    const timeout = setTimeout(() => {
      if (!mountedRef.current) return
      setCharIndex((prev) => prev + 1)
    }, 120)

    return () => clearTimeout(timeout)
  }, [displayText, charIndex])

  return (
    <div className={`font-mono text-[13px] leading-[1.5] px-4 py-1 ${className}`}>
      <div className="flex items-start gap-2">
        <MessageDot type="assistant-wip" />
        <div className="flex-1 min-w-0">
          <span style={{ color: "#E07A5F" }}>
            {displayText.slice(0, charIndex)}
          </span>
        </div>
      </div>
    </div>
  )
}
