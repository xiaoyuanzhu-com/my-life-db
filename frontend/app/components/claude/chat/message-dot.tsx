import type { ToolStatus } from '~/types/claude'

interface MessageDotProps {
  status?: ToolStatus | 'assistant' | 'user' | 'system'
  /**
   * Line height context for alignment:
   * - 'prose': 24px (15px × 1.6) - for assistant message content
   * - 'mono': 20px (13px × 1.5) - for tool blocks, thinking, etc.
   */
  lineHeight?: 'prose' | 'mono'
}

/**
 * Unified dot/bullet component for all message types.
 * The dot is vertically centered within a container that matches
 * the line-height of the adjacent text.
 */
export function MessageDot({ status = 'assistant', lineHeight = 'mono' }: MessageDotProps) {
  if (status === 'user') {
    return null
  }

  const getBulletColor = () => {
    if (status === 'assistant') return '#5F6368' // Gray for assistant messages
    if (status === 'system') return '#6B7280' // Muted gray for system/debug messages
    if (status === 'failed') return '#D92D20' // Red
    if (status === 'running') return '#F59E0B' // Orange/Yellow
    if (status === 'pending') return '#9CA3AF' // Gray
    if (status === 'permission_required') return '#F59E0B' // Orange
    return '#22C55E' // Green for success/completed
  }

  const bulletChar = status === 'pending' ? '○' : '●'

  // Match the line-height of the text context
  // prose: 15px * 1.6 = 24px, mono: 13px * 1.5 = 19.5px ≈ 20px
  const heightClass = lineHeight === 'prose' ? 'h-6' : 'h-5'

  return (
    <span
      className={`select-none font-mono text-xs ${heightClass} flex items-center shrink-0`}
      style={{ color: getBulletColor() }}
    >
      {bulletChar}
    </span>
  )
}
