/**
 * RateLimitWarning — Dismissible amber banner shown when Claude API quota utilization
 * reaches a high threshold ("allowed_warning" status, ≥ 75% by default).
 *
 * Designed to be non-intrusive: sits between the message list and the chat input
 * so it never obscures conversation content. The user can dismiss it manually, or
 * it auto-clears when a subsequent rate_limit_event reports a lower status.
 */

interface RateLimitWarningProps {
  /** Quota utilization 0–1 (e.g. 0.94 = 94 %) */
  utilization: number
  /** Rate limit window type (e.g. "seven_day", "five_hour") */
  rateLimitType: string
  /** Unix timestamp (seconds) when the quota resets */
  resetsAt: number
  /** Called when the user clicks × or when auto-dismissed by a new event */
  onDismiss: () => void
}

/** Map API rate limit type strings to human-readable labels */
function formatRateLimitType(type: string): string {
  switch (type) {
    case 'seven_day': return '7-day'
    case 'five_hour': return '5-hour'
    case 'one_hour':  return '1-hour'
    case 'one_minute': return '1-minute'
    default: return type.replace(/_/g, ' ')
  }
}

/** Format seconds-until-reset as "X h Y m" or "Y m" */
function formatTimeUntilReset(resetsAtSeconds: number): string {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const secsRemaining = Math.max(0, resetsAtSeconds - nowSeconds)
  if (secsRemaining === 0) return 'soon'

  const hours = Math.floor(secsRemaining / 3600)
  const minutes = Math.floor((secsRemaining % 3600) / 60)

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h`
  return `${minutes}m`
}

export function RateLimitWarning({ utilization, rateLimitType, resetsAt, onDismiss }: RateLimitWarningProps) {
  const pct = Math.round(utilization * 100)
  const windowLabel = formatRateLimitType(rateLimitType)
  const resetLabel = formatTimeUntilReset(resetsAt)

  return (
    <div
      role="alert"
      className="flex items-center gap-3 px-4 py-2 text-sm border-t"
      style={{
        backgroundColor: 'color-mix(in srgb, #F59E0B 12%, transparent)',
        borderColor: 'color-mix(in srgb, #F59E0B 30%, transparent)',
        color: 'var(--claude-text-secondary)',
      }}
    >
      {/* Warning icon */}
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0, color: '#F59E0B' }}
      >
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>

      {/* Message */}
      <span className="flex-1">
        <strong style={{ color: '#F59E0B' }}>{pct}%</strong> of your {windowLabel} rate limit used.
        Resets in {resetLabel}.
      </span>

      {/* Dismiss button */}
      <button
        onClick={onDismiss}
        aria-label="Dismiss rate limit warning"
        className="flex-shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 transition-opacity"
        style={{ color: 'var(--claude-text-secondary)' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  )
}
