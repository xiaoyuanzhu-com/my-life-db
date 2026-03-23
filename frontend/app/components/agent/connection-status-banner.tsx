/**
 * ConnectionStatusBanner -- shows connection state for the ACP WebSocket.
 *
 * Matches the old Claude Code connection-status-banner.tsx pattern:
 * - CSS grid reveal/conceal animation (not instant show/hide)
 * - Muted text, proper icons (Loader2 spinning, WifiOff, Check)
 * - Auto-dismiss reconnected after 1.5s
 */
import { useState, useEffect, useRef } from "react"
import { Loader2, WifiOff, Check } from "lucide-react"
import { cn } from "~/lib/utils"

interface ConnectionStatusBannerProps {
  connected: boolean
  /** Whether we've ever been connected (to distinguish initial connecting from reconnecting) */
  hasSession: boolean
}

type BannerState = "connecting" | "disconnected" | "connected" | "hidden"

export function ConnectionStatusBanner({
  connected,
  hasSession,
}: ConnectionStatusBannerProps) {
  const [state, setState] = useState<BannerState>("hidden")
  const [isDismissing, setIsDismissing] = useState(false)
  const wasConnected = useRef(false)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!hasSession) {
      setState("hidden")
      setIsDismissing(false)
      return
    }

    if (connected) {
      if (wasConnected.current) {
        // Was disconnected, now reconnected -- show success briefly
        setState("connected")
        setIsDismissing(false)
        dismissTimer.current = setTimeout(() => {
          setIsDismissing(true)
          // After conceal animation completes, hide completely
          setTimeout(() => {
            setState("hidden")
            setIsDismissing(false)
          }, 200)
        }, 1500)
      } else {
        // First connect -- no banner needed
        setState("hidden")
      }
      wasConnected.current = true
    } else {
      if (wasConnected.current) {
        // Was connected, now disconnected
        setState("disconnected")
        setIsDismissing(false)
      } else {
        // Still trying to connect for the first time
        setState("connecting")
        setIsDismissing(false)
      }
    }

    return () => {
      if (dismissTimer.current) {
        clearTimeout(dismissTimer.current)
      }
    }
  }, [connected, hasSession])

  if (state === "hidden") return null

  let icon: React.ReactNode
  let text: string

  switch (state) {
    case "connecting":
      icon = <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
      text = "Reconnecting..."
      break
    case "disconnected":
      icon = <WifiOff className="h-3.5 w-3.5 shrink-0" />
      text = "Disconnected."
      break
    case "connected":
      icon = <Check className="h-3.5 w-3.5 shrink-0" />
      text = "Connected."
      break
  }

  return (
    <div
      className={cn("collapsible-grid", isDismissing && "collapsed")}
    >
      <div className="collapsible-grid-content">
        <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground border-b border-border">
          {icon}
          <span>{text}</span>
        </div>
      </div>
    </div>
  )
}
