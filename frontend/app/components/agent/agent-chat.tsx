/**
 * AgentChat — Chat UI component backed by the ACP WebSocket runtime.
 *
 * Expects to be rendered inside an AssistantRuntimeProvider + AgentContextProvider
 * (provided by the route). Delegates message rendering to the generated Thread
 * component, which uses our custom AssistantMessage (with tool dispatch) and
 * UserMessage components.
 */
import { cn } from "~/lib/utils"
import { Thread } from "~/components/assistant-ui/thread"

// TODO: restore mobile scroll-direction hiding (hide composer on scroll down)
// TODO: restore DraftPersistenceSync (uses useComposerRuntime to sync draft to localStorage)
// TODO: restore user message truncation (10 lines / 500 chars) with gradient fade

// ── Main component ─────────────────────────────────────────────────────────

interface AgentChatProps {
  /**
   * Session ID — used for draft persistence and connection status display.
   * Pass an empty string when there is no active session (new-session empty state).
   */
  sessionId: string
  className?: string
}

/**
 * AgentChat provides the full chat UI for an ACP agent session.
 * Mount with a sessionId to connect via WebSocket. When sessionId is empty,
 * it shows the empty state with the composer.
 */
export function AgentChat({
  sessionId,
  className,
}: AgentChatProps) {
  return (
    <div className={cn("flex flex-col h-full bg-background", className)}>
      <Thread />
    </div>
  )
}
