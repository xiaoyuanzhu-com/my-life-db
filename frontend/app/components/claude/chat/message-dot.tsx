import type { ToolStatus } from '~/types/claude'

interface MessageDotProps {
  status?: ToolStatus | 'assistant' | 'user'
}

/**
 * Unified dot/bullet component for all message types
 * - User messages: no dot
 * - Assistant messages: gray dot
 * - Tool calls: status-colored dot
 */
export function MessageDot({ status = 'assistant' }: MessageDotProps) {
  // User messages don't get a dot
  if (status === 'user') {
    return null
  }

  const getBulletColor = () => {
    if (status === 'assistant') return '#5F6368' // Gray for assistant messages
    if (status === 'failed') return '#D92D20' // Red
    if (status === 'running') return '#F59E0B' // Orange/Yellow
    if (status === 'pending') return '#9CA3AF' // Gray
    if (status === 'permission_required') return '#F59E0B' // Orange
    return '#22C55E' // Green for success/completed
  }

  // Use outline circle for pending state, filled for everything else
  const bulletChar = status === 'pending' ? '○' : '●'

  return (
    <span
      className="select-none text-[13px] leading-[1.5]"
      style={{ color: getBulletColor() }}
    >
      {bulletChar}
    </span>
  )
}
