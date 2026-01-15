import { ClaudeTerminal } from './terminal'

interface SessionTabProps {
  sessionId: string
  isActive: boolean
}

export function SessionTab({ sessionId, isActive }: SessionTabProps) {
  return (
    <div
      className={isActive ? 'block h-full' : 'hidden'}
      data-session-id={sessionId}
    >
      <ClaudeTerminal sessionId={sessionId} />
    </div>
  )
}
