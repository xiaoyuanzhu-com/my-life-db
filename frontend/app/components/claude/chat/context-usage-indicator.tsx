import { useState } from 'react'
import { Minimize2 } from 'lucide-react'
import { cn } from '~/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'

/** Format token count for compact display */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`
  return tokens.toString()
}

/** Format percentage for display */
function formatPercent(tokens: number, total: number): string {
  if (total === 0) return '0%'
  const pct = (tokens / total) * 100
  if (pct < 1 && pct > 0) return '<1%'
  return `${Math.round(pct)}%`
}

/** Format model name for display: claude-sonnet-4-6-20250514 → claude-sonnet-4-6 */
function formatModelName(model?: string): string | undefined {
  if (!model) return undefined
  // Strip date suffix (e.g. -20250514)
  return model.replace(/-\d{8}$/, '')
}

export interface ContextUsage {
  /** Total input tokens (non-cached + cache creation + cache read) */
  inputTokens: number
  /** Context window size from the API */
  contextWindow: number
  /** Non-cached input tokens (usage.input_tokens) */
  rawInputTokens: number
  /** Tokens being cached this call (usage.cache_creation_input_tokens) */
  cacheCreationTokens: number
  /** Tokens served from cache (usage.cache_read_input_tokens) */
  cacheReadTokens: number
  /** Model identifier, e.g. "claude-sonnet-4-6-20250514" */
  modelName?: string
}

interface ContextUsageIndicatorProps {
  /** Context usage data (null if no result message received yet) */
  usage: ContextUsage | null
  /** Called when user clicks the compact button inside the popover */
  onCompact?: () => void
  /** Whether the indicator is disabled */
  disabled?: boolean
}

/** Claude Code reserves ~16.5% of the context window as autocompact buffer */
const AUTOCOMPACT_BUFFER_RATIO = 0.165

export function ContextUsageIndicator({
  usage,
  onCompact,
  disabled = false,
}: ContextUsageIndicatorProps) {
  const [open, setOpen] = useState(false)

  if (!usage) return null

  const usedTokens = usage.inputTokens
  const maxTokens = usage.contextWindow
  const autocompactBuffer = Math.round(maxTokens * AUTOCOMPACT_BUFFER_RATIO)
  const freeTokens = Math.max(0, maxTokens - usedTokens - autocompactBuffer)

  // Combined percentage (tokens + buffer) — matches CLI status bar behavior
  const percentage = Math.min(Math.round(((usedTokens + autocompactBuffer) / maxTokens) * 100), 100)

  // SVG circle parameters — sized to match other bar icons (h-3/h-3.5 = 12/14px)
  const size = 14
  const strokeWidth = 2
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (percentage / 100) * circumference

  const displayModel = formatModelName(usage.modelName)

  const handleCompact = () => {
    setOpen(false)
    onCompact?.()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title="Context window usage"
          className={cn(
            'flex items-center gap-1 sm:gap-1.5 px-1 sm:px-1.5 py-0.5 rounded-md',
            'text-muted-foreground hover:text-foreground hover:bg-foreground/10',
            'cursor-pointer transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-50',
            open && 'bg-accent text-foreground',
          )}
          aria-label={`Context window: ${percentage}% used`}
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
      </PopoverTrigger>

      <PopoverContent
        className="w-64 p-3"
        align="start"
        side="top"
        sideOffset={8}
      >
        {/* Header: model + summary */}
        <div className="text-xs font-medium text-foreground whitespace-nowrap tabular-nums">
          {displayModel && (
            <span>{displayModel} &middot; </span>
          )}
          {formatTokens(usedTokens)} / {formatTokens(maxTokens)} ({percentage}%)
        </div>

        {/* Breakdown rows */}
        <div className="mt-2 text-xs text-muted-foreground tabular-nums space-y-0.5">
          <div className="flex justify-between">
            <span>Cache read</span>
            <span>{formatTokens(usage.cacheReadTokens)} ({formatPercent(usage.cacheReadTokens, maxTokens)})</span>
          </div>
          <div className="flex justify-between">
            <span>Cache write</span>
            <span>{formatTokens(usage.cacheCreationTokens)} ({formatPercent(usage.cacheCreationTokens, maxTokens)})</span>
          </div>
          <div className="flex justify-between">
            <span>New input</span>
            <span>{formatTokens(usage.rawInputTokens)} ({formatPercent(usage.rawInputTokens, maxTokens)})</span>
          </div>
          <div className="flex justify-between">
            <span>Free space</span>
            <span>{formatTokens(freeTokens)} ({formatPercent(freeTokens, maxTokens)})</span>
          </div>
          <div className="flex justify-between">
            <span>Autocompact buffer</span>
            <span>{formatTokens(autocompactBuffer)} ({formatPercent(autocompactBuffer, maxTokens)})</span>
          </div>
        </div>

        {/* Compact button */}
        {onCompact && (
          <button
            type="button"
            onClick={handleCompact}
            disabled={disabled}
            className={cn(
              'w-full mt-3 px-3 py-1.5 rounded-md text-sm',
              'flex items-center justify-center gap-1.5',
              'bg-secondary text-secondary-foreground',
              'hover:bg-secondary/80 transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            <Minimize2 className="h-3.5 w-3.5" />
            Compact conversation
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
