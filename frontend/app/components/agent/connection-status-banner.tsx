/**
 * ConnectionStatusBanner -- shows connection state for the ACP WebSocket.
 *
 * Renders inside the composer shell (attached to top of input box).
 * Uses banner-grid CSS for slide-open/slide-closed animations.
 * Optimistic no-show: hidden by default, grace period before showing disconnected.
 */
import { useState, useEffect, useRef, useCallback } from "react"
import { Loader2, WifiOff, Check } from "lucide-react"
import { cn } from "~/lib/utils"

interface ConnectionStatusBannerProps {
  connected: boolean
  /** Whether we've ever been connected (to distinguish initial connecting from reconnecting) */
  hasSession: boolean
}

type BannerState = "disconnected" | "connected" | "hidden"

/** Grace period (ms) before showing disconnected banner — avoids flash on brief drops */
const DISCONNECT_GRACE_MS = 2000

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
      clearTimers()
      return
    }

    if (connected) {
      if (wasConnected.current) {
        // Was disconnected, now reconnected — show "Connected." briefly
        setState("connected")
        setIsDismissing(false)
        if (dismissTimer.current) clearTimeout(dismissTimer.current)
        dismissTimer.current = setTimeout(() => {
          setIsDismissing(true)
          // onTransitionEnd will set state to hidden
        }, 1500)
      } else {
        // First connect — no banner needed (optimistic)
        setState("hidden")
      }
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
  }, [connected, hasSession, clearTimers])

  const handleTransitionEnd = useCallback((e: React.TransitionEvent) => {
    if (e.propertyName === "grid-template-rows" && isDismissing) {
      setState("hidden")
      setIsDismissing(false)
    }
  }, [isDismissing])

  if (state === "hidden") return null

  const isReconnected = state === "connected"

  let icon: React.ReactNode
  let text: string

  if (isReconnected) {
    icon = <Check className="h-3.5 w-3.5 shrink-0" />
    text = "Connected."
  } else {
    icon = <WifiOff className="h-3.5 w-3.5 shrink-0" />
    text = "Disconnected."
  }

  return (
    <div
      className={cn("banner-grid", isDismissing && "concealing")}
      onTransitionEnd={handleTransitionEnd}
    >
      <div className="banner-grid-content">
        <div className="flex items-center gap-2 px-3 py-1.5 text-[13px] text-muted-foreground border-b border-border">
          {icon}
          <span>{text}</span>
        </div>
      </div>
    </div>
  )
}
