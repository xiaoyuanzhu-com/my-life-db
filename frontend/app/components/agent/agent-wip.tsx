/**
 * AgentWIP -- Work-in-Progress indicator shown when the agent is working.
 *
 * Shows a dot with animated "Working" → "Working." → "Working.." → "Working..."
 */
import { useState, useEffect } from "react"
import { MessageDot } from "./message-dot"

export function AgentWIP() {
  const [dotCount, setDotCount] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setDotCount((prev) => (prev + 1) % 4)
    }, 500)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="mb-4 text-sm">
      <div className="min-w-0">
        <div className="group/text relative flex items-start gap-2">
          <MessageDot type="assistant-wip" />
          <div className="flex-1 min-w-0">
            <span className="text-foreground">Working{".".repeat(dotCount)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
