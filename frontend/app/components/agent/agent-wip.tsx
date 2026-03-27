/**
 * AgentWIP -- Work-in-Progress indicator shown when the agent is working.
 *
 * Shows a pulsing dot with "Working..." text.
 */
import { MessageDot } from "./message-dot"

interface AgentWIPProps {
  className?: string
}

export function AgentWIP({ className = "" }: AgentWIPProps) {
  return (
    <div className={`py-1 ${className}`}>
      <div className="font-mono text-[13px] leading-[1.5] flex items-start gap-2">
        <MessageDot type="assistant-wip" />
        <div className="flex-1 min-w-0">
          <span className="text-foreground">Working...</span>
        </div>
      </div>
    </div>
  )
}
