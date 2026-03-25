import { Loader2, WifiOff, Check } from 'lucide-react'
import { cn } from '~/lib/utils'
import type { ConnectionStatus } from './hooks'

interface ConnectionStatusBannerProps {
  status: ConnectionStatus
  /** Whether we just reconnected (show success state) */
  isReconnected?: boolean
  /** Whether to animate out */
  isDismissing?: boolean
  /** Called when dismissal animation completes */
  onDismissed?: () => void
}

export function ConnectionStatusBanner({
  status,
  isReconnected = false,
  isDismissing = false,
  onDismissed,
}: ConnectionStatusBannerProps) {
  const handleTransitionEnd = (e: React.TransitionEvent) => {
    // Only handle grid-template-rows transition, not other properties
    if (e.propertyName === 'grid-template-rows' && isDismissing && onDismissed) {
      onDismissed()
    }
  }

  // Determine which icon and text to show
  let icon: React.ReactNode
  let text: string

  if (isReconnected) {
    icon = <Check className="h-3.5 w-3.5 shrink-0" />
    text = 'Connected.'
  } else if (status === 'connecting') {
    icon = <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
    text = 'Reconnecting. Your input is saved locally.'
  } else {
    icon = <WifiOff className="h-3.5 w-3.5 shrink-0" />
    text = 'Disconnected. Your input is saved locally.'
  }

  return (
    <div
      className={cn('banner-grid', isDismissing && 'concealing')}
      onTransitionEnd={handleTransitionEnd}
    >
      <div className="banner-grid-content">
        <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground border-b border-border">
          {icon}
          <span>{text}</span>
        </div>
      </div>
    </div>
  )
}
