/**
 * ConnectionStatusBanner -- shows connection state for the ACP WebSocket.
 *
 * Renders inside the composer shell (attached to top of input box).
 * Uses banner-grid CSS for slide-open/slide-closed animations.
 *
 * Behavior:
 * - Disconnected banner only appears after a 5s grace period (avoids flashing
 *   on session switches or brief network blips).
 * - Connected banner only appears when recovering from a *visible* disconnected
 *   state. If the disconnect resolved within the grace period, nothing shows.
 */
import { useState, useEffect, useRef, useCallback } from "react"
import { WifiOff, Check } from "lucide-react"
import { cn } from "~/lib/utils"

interface ConnectionStatusBannerProps {
  connected: boolean
  /** Whether we've ever been connected (to distinguish initial connecting from reconnecting) */
  hasSession: boolean
}

type BannerState = "disconnected" | "connected" | "hidden"

/** Grace period (ms) before showing disconnected banner */
const DISCONNECT_GRACE_MS = 5000

export function ConnectionStatusBanner({
  connected,
  hasSession,
}: ConnectionStatusBannerProps) {
  const [state, setState] = useState<BannerState>("hidden")
  const [isDismissing, setIsDismissing] = useState(false)
  const wasConnected = useRef(false)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = useCallback(() => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current)
      dismissTimer.current = null
    }
    if (graceTimer.current) {
      clearTimeout(graceTimer.current)
      graceTimer.current = null
    }
  }, [])

  useEffect(() => {
    // Clear grace timer on every connection state change
    if (graceTimer.current) {
      clearTimeout(graceTimer.current)
      graceTimer.current = null
    }

    if (!hasSession) {
      setState("hidden")
      setIsDismissing(false)
      wasConnected.current = false
      clearTimers()
      return
    }

    if (connected) {
      if (state === "disconnected") {
        // Recovering from a *visible* disconnected state — show "Connected."
        setState("connected")
        setIsDismissing(false)
        if (dismissTimer.current) clearTimeout(dismissTimer.current)
        dismissTimer.current = setTimeout(() => {
          setIsDismissing(true)
        }, 1500)
      }
      // If state is "hidden", disconnect was never shown — stay silent
      wasConnected.current = true
    } else {
      if (wasConnected.current) {
        // Was connected, now disconnected — wait grace period before showing
        graceTimer.current = setTimeout(() => {
          setState("disconnected")
          setIsDismissing(false)
        }, DISCONNECT_GRACE_MS)
      }
      // First-time connecting: stay hidden (optimistic no-show)
    }

    return clearTimers
  }, [connected, hasSession]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleTransitionEnd = useCallback((e: React.TransitionEvent) => {
    if (e.propertyName === "grid-template-rows" && isDismissing) {
      setState("hidden")
      setIsDismissing(false)
    }
  }, [isDismissing])

  if (state === "hidden") return null

  const isReconnected = state === "connected"

  return (
    <div
      className={cn("banner-grid", isDismissing && "concealing")}
      onTransitionEnd={handleTransitionEnd}
    >
      <div className="banner-grid-content">
        <div className="flex items-center gap-2 px-3 py-1.5 text-[13px] text-muted-foreground border-b border-border">
          {isReconnected
            ? <Check className="h-3.5 w-3.5 shrink-0" />
            : <WifiOff className="h-3.5 w-3.5 shrink-0" />
          }
          <span>{isReconnected ? "Connected." : "Disconnected."}</span>
        </div>
      </div>
    </div>
  )
}
