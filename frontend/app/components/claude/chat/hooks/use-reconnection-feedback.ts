import { useState, useEffect, useRef, useCallback } from 'react'

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
  const prevStatusRef = useRef<ConnectionStatus | null>(null)
  const [showReconnected, setShowReconnected] = useState(false)
  const [isDismissing, setIsDismissing] = useState(false)

  // Detect reconnection synchronously during render to avoid flash
  // This runs before effects, so the banner stays visible during transition
  const wasDisconnected = prevStatusRef.current !== null && prevStatusRef.current !== 'connected'
  const justReconnected = wasDisconnected && connectionStatus === 'connected'

  // Update ref synchronously (before effects run)
  // We update it here so the next render sees the current value as "previous"
  const currentPrev = prevStatusRef.current
  prevStatusRef.current = connectionStatus

  // Handle reconnection - set state synchronously if we just reconnected
  if (justReconnected && !showReconnected) {
    setShowReconnected(true)
    setIsDismissing(false)
  }

  // Handle disconnection - reset all state
  if (currentPrev === 'connected' && connectionStatus !== 'connected') {
    if (showReconnected || isDismissing) {
      setShowReconnected(false)
      setIsDismissing(false)
    }
  }

  // Start dismissal timer when showing reconnected message
  useEffect(() => {
    if (showReconnected && !isDismissing) {
      const timer = setTimeout(() => {
        setIsDismissing(true)
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [showReconnected, isDismissing])

  const onDismissed = useCallback(() => {
    setShowReconnected(false)
    setIsDismissing(false)
  }, [])

  return { showReconnected, isDismissing, onDismissed }
}
