import { cn } from '~/lib/utils'

/** Format token count for compact display */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`
  return tokens.toString()
}

export interface ContextUsage {
  /** Total input tokens (non-cached + cache creation + cache read) */
  inputTokens: number
  /** Context window size from the API */
  contextWindow: number
}

interface ContextUsageIndicatorProps {
  /** Context usage data (null if no result message received yet) */
  usage: ContextUsage | null
  /** Called when user clicks the indicator to trigger compact */
  onCompact?: () => void
  /** Whether the indicator is disabled */
  disabled?: boolean
}

export function ContextUsageIndicator({
  usage,
  onCompact,
  disabled = false,
}: ContextUsageIndicatorProps) {
  if (!usage) return null

  const usedTokens = usage.inputTokens
  const maxTokens = usage.contextWindow
  const percentage = Math.min(Math.round((usedTokens / maxTokens) * 100), 100)

  // SVG circle parameters — sized to match other bar icons (h-3/h-3.5 = 12/14px)
  const size = 14
  const strokeWidth = 2
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (percentage / 100) * circumference

  const tooltip = `${formatTokens(usedTokens)} / ${formatTokens(maxTokens)} tokens (${percentage}%)\nClick to compact`

  return (
    <button
      type="button"
      onClick={onCompact}
      disabled={disabled || !onCompact}
      title={tooltip}
      className={cn(
        'flex items-center gap-1 sm:gap-1.5 px-1 sm:px-1.5 py-0.5 rounded-md',
        'text-muted-foreground hover:text-foreground hover:bg-foreground/10',
        'cursor-pointer transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
      aria-label={`Context window: ${percentage}% used. Click to compact.`}
    >
      {/* Circular progress ring */}
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="flex-shrink-0 -rotate-90"
      >
        {/* Background ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          opacity={0.2}
        />
        {/* Progress ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          className="transition-all duration-500"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
      {/* Percentage text */}
      <span className="text-[11px] font-medium tabular-nums hidden sm:inline">
        {percentage}%
      </span>
    </button>
  )
}
