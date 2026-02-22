import { cn } from '~/lib/utils'

/** Known model context window sizes (in tokens) */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Claude 4 family
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4-20250514': 200_000,
  // Claude 3.5 family
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-5-sonnet-20240620': 200_000,
  // Claude 3 family
  'claude-3-opus-20240229': 200_000,
  'claude-3-sonnet-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,
}

/** Default context window for unknown models */
const DEFAULT_CONTEXT_WINDOW = 200_000

/** Get context window size for a model name */
export function getContextWindowSize(model: string): number {
  // Direct match
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model]

  // Prefix match (handles version suffixes like "-latest")
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(key.split('-20')[0])) return value
  }

  return DEFAULT_CONTEXT_WINDOW
}

/** Format token count for compact display */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`
  return tokens.toString()
}

export interface ContextUsage {
  /** Input tokens from the latest assistant message */
  inputTokens: number
  /** Output tokens from the latest assistant message */
  outputTokens: number
  /** Model name from the init message */
  model: string
}

interface ContextUsageIndicatorProps {
  /** Context usage data (null if no data available yet) */
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

  const maxTokens = getContextWindowSize(usage.model)
  // Context window usage = total input tokens (non-cached + cache creation + cache read)
  // The inputTokens field is pre-computed to include all cached tokens
  const usedTokens = usage.inputTokens
  const percentage = Math.min(Math.round((usedTokens / maxTokens) * 100), 100)

  // SVG circle parameters
  const size = 22
  const strokeWidth = 2.5
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
          className="stroke-muted"
          strokeWidth={strokeWidth}
        />
        {/* Progress ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          className="stroke-muted-foreground transition-all duration-500"
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
