/**
 * AgentWIP — Work-in-Progress indicator shown when the agent is working.
 *
 * Displays a pulsing dot with "Working..." text.
 * Placed between the last message and the composer.
 */
import { MessageDot } from "./message-dot"

interface AgentWIPProps {
  className?: string
}

export function AgentWIP({ className = "" }: AgentWIPProps) {
  return (
    <div className={`flex items-center gap-2 px-4 py-2 ${className}`}>
      <MessageDot type="assistant-wip" />
      <span className="text-sm text-muted-foreground animate-pulse">
        Working...
      </span>
    </div>
  )
}
