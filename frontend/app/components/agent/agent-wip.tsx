/**
 * AgentWIP -- Work-in-Progress indicator shown when the agent is working.
 *
 * Shows a dot with shimmer "Working" label.
 */
import { MessageDot } from "./message-dot"

export function AgentWIP() {
  return (
    <div className="mb-4 text-sm">
      <div className="min-w-0">
        <div className="group/text relative flex items-start gap-2">
          <MessageDot type="assistant-wip" />
          <div className="flex-1 min-w-0">
            <span className="shimmer inline-block font-medium text-foreground motion-reduce:animate-none">
              Working
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
