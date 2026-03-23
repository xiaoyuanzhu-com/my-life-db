/**
 * ConnectionStatusBanner — shows connection state for the ACP WebSocket.
 *
 * Three states:
 * - connecting: spinner + "Reconnecting..."
 * - disconnected: wifi-off icon + "Disconnected."
 * - connected: check icon + "Connected." (auto-dismiss after 1.5s)
 */
import { useState, useEffect, useRef } from "react"
import { Loader2, WifiOff, Check } from "lucide-react"

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
  const wasConnected = useRef(false)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!hasSession) {
      setState("hidden")
      return
    }

    if (connected) {
      if (wasConnected.current) {
        // Was disconnected, now reconnected -- show success briefly
        setState("connected")
        dismissTimer.current = setTimeout(() => {
          setState("hidden")
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
      } else {
        // Still trying to connect for the first time
        setState("connecting")
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
    <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 text-[11px] text-muted-foreground bg-muted/50 border-b border-border">
      {icon}
      <span>{text}</span>
    </div>
  )
}
