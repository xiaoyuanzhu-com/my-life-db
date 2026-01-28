import { useState, useEffect, useRef } from 'react'

/** WebSocket connection status */
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'

interface ReconnectionFeedback {
  /** Whether to show the "Connected." success message */
  showReconnected: boolean
  /** Whether the success message is animating out */
  isDismissing: boolean
  /** Call when dismissal animation completes */
  onDismissed: () => void
}

/**
 * Tracks reconnection state to show success feedback after reconnecting.
 * Shows "Connected." for 1.5s after transitioning from non-connected → connected.
 */
export function useReconnectionFeedback(connectionStatus: ConnectionStatus): ReconnectionFeedback {
  const prevConnectionStatusRef = useRef(connectionStatus)
  const [showReconnected, setShowReconnected] = useState(false)
  const [isDismissing, setIsDismissing] = useState(false)

  useEffect(() => {
    const prev = prevConnectionStatusRef.current
    prevConnectionStatusRef.current = connectionStatus

    if (prev !== 'connected' && connectionStatus === 'connected') {
      // Just reconnected - show success feedback
      setShowReconnected(true)
      setIsDismissing(false)
      // After 1.5s, start dismissal animation
      const timer = setTimeout(() => {
        setIsDismissing(true)
      }, 1500)
      return () => clearTimeout(timer)
    } else if (connectionStatus !== 'connected') {
      // Connection lost - reset reconnection feedback state
      setShowReconnected(false)
      setIsDismissing(false)
    }
  }, [connectionStatus])

  const onDismissed = () => setShowReconnected(false)

  return { showReconnected, isDismissing, onDismissed }
}
