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

export interface ContextUsage {
  /** Total input tokens (non-cached + cache creation + cache read) */
  inputTokens: number
  /** Context window size from the API */
  contextWindow: number
}

interface ContextUsageIndicatorProps {
  /** Context usage data (null if no result message received yet) */
  usage: ContextUsage | null
  /** Called when user clicks the compact button inside the popover */
  onCompact?: () => void
  /** Whether the indicator is disabled */
  disabled?: boolean
}

export function ContextUsageIndicator({
  usage,
  onCompact,
  disabled = false,
}: ContextUsageIndicatorProps) {
  const [open, setOpen] = useState(false)

  if (!usage) return null

  const usedTokens = usage.inputTokens
  const maxTokens = usage.contextWindow
  const percentage = Math.min(Math.round((usedTokens / maxTokens) * 100), 100)

  // Color thresholds
  const isWarning = percentage >= 60
  const isDanger = percentage >= 85

  // SVG circle parameters — sized to match other bar icons (h-3/h-3.5 = 12/14px)
  const size = 14
  const strokeWidth = 2
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (percentage / 100) * circumference

  // SVG circle parameters (larger ring for popover)
  const popoverSize = 48
  const popoverStrokeWidth = 4
  const popoverRadius = (popoverSize - popoverStrokeWidth) / 2
  const popoverCircumference = 2 * Math.PI * popoverRadius
  const popoverDashOffset =
    popoverCircumference - (percentage / 100) * popoverCircumference

  const progressColorClass = isDanger
    ? 'stroke-destructive'
    : isWarning
      ? 'stroke-yellow-500'
      : 'stroke-muted-foreground'

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
        <div className="flex items-start gap-3">
          {/* Larger progress ring with percentage inside */}
          <div className="relative flex-shrink-0">
            <svg
              width={popoverSize}
              height={popoverSize}
              viewBox={`0 0 ${popoverSize} ${popoverSize}`}
              className="-rotate-90"
            >
              <circle
                cx={popoverSize / 2}
                cy={popoverSize / 2}
                r={popoverRadius}
                fill="none"
                className="stroke-muted"
                strokeWidth={popoverStrokeWidth}
              />
              <circle
                cx={popoverSize / 2}
                cy={popoverSize / 2}
                r={popoverRadius}
                fill="none"
                className={cn(
                  progressColorClass,
                  'transition-all duration-500',
                )}
                strokeWidth={popoverStrokeWidth}
                strokeLinecap="round"
                strokeDasharray={popoverCircumference}
                strokeDashoffset={popoverDashOffset}
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums">
              {percentage}%
            </span>
          </div>

          {/* Details */}
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="text-sm font-medium text-foreground">
              Context Window
            </div>
            <div className="text-xs text-muted-foreground tabular-nums space-y-0.5">
              <div className="flex justify-between">
                <span>Used</span>
                <span>{formatTokens(usedTokens)}</span>
              </div>
              <div className="flex justify-between">
                <span>Remaining</span>
                <span>{formatTokens(maxTokens - usedTokens)}</span>
              </div>
              <div className="flex justify-between border-t border-border pt-0.5 font-medium text-foreground">
                <span>Total</span>
                <span>{formatTokens(maxTokens)}</span>
              </div>
            </div>
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
