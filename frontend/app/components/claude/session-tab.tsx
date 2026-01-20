import { ClaudeTerminal } from './terminal'

interface SessionTabProps {
  sessionId: string
  isActive: boolean
}

export function SessionTab({ sessionId, isActive }: SessionTabProps) {
  // Only mount the terminal when this tab is active
  // This prevents inactive sessions from connecting WebSockets and activating
  if (!isActive) {
    return null
  }

  return (
    <div className="h-full" data-session-id={sessionId}>
      <ClaudeTerminal sessionId={sessionId} />
    </div>
  )
}
