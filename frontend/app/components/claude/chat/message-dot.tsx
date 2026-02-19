import type { ToolStatus } from '~/types/claude'

export type MessageDotType =
  | 'claude-wip'
  | 'assistant-wip'
  | 'assistant'
  | 'thinking-wip'
  | 'thinking'
  | 'tool-pending'
  | 'tool-completed'
  | 'tool-failed'
  | 'compacting'
  | 'system'

interface MessageDotProps {
  type: MessageDotType
}

// Style lookup: type → { color, char, pulse }
const DOT_STYLES: Record<MessageDotType, { color: string; char: string; pulse: boolean }> = {
  'claude-wip':    { color: '#E07A5F', char: '●', pulse: true },
  'assistant-wip': { color: '#5F6368', char: '●', pulse: true },
  'assistant':     { color: '#5F6368', char: '●', pulse: false },
  'thinking-wip':  { color: '#5F6368', char: '●', pulse: true },
  'thinking':      { color: '#5F6368', char: '●', pulse: false },
  'tool-pending':  { color: '#9CA3AF', char: '○', pulse: true },
  'tool-completed':{ color: '#22C55E', char: '●', pulse: false },
  'tool-failed':   { color: '#D92D20', char: '●', pulse: false },
  'compacting':    { color: '#5F6368', char: '●', pulse: false },
  'system':        { color: '#22C55E', char: '●', pulse: false },
}

/**
 * Unified dot/bullet component for all message types.
 * The dot is vertically centered within a container matching
 * mono line-height (20px).
 */
export function MessageDot({ type }: MessageDotProps) {
  const style = DOT_STYLES[type]

  return (
    <span
      className={`select-none font-mono text-xs h-5 flex items-center shrink-0 ${style.pulse ? 'animate-pulse' : ''}`}
      style={{ color: style.color }}
    >
      {style.char}
    </span>
  )
}

/** Map a ToolStatus from the data model to a MessageDotType. */
export function toolStatusToDotType(status: ToolStatus): MessageDotType {
  if (status === 'failed') return 'tool-failed'
  if (status === 'completed') return 'tool-completed'
  return 'tool-pending' // pending, running, permission_required
}
