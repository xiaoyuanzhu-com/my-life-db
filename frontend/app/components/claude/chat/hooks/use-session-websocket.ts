import { useState, useRef, useCallback, useEffect } from 'react'
import type { ConnectionStatus } from './use-reconnection-feedback'
import { refreshAccessToken } from '~/lib/fetch-with-refresh'

export { type ConnectionStatus }

export interface UseSessionWebSocketOptions {
  /** Called for each message received from WebSocket */
  onMessage: (data: unknown) => void
}

export interface UseSessionWebSocketResult {
  /** Current connection status */
  connectionStatus: ConnectionStatus
  /** Whether we've ever successfully connected (for showing reconnection banner) */
  hasConnected: boolean
  /** Send a message via WebSocket (connects lazily if needed) */
  sendMessage: (payload: unknown) => Promise<void>
  /** Send raw JSON via WebSocket (connects lazily if needed) */
  sendRaw: (json: string) => Promise<void>
}

/**
 * Manages WebSocket connection to a Claude session.
 * Handles connection, reconnection with exponential backoff, and message routing.
 */
export function useSessionWebSocket(
  sessionId: string,
  { onMessage }: UseSessionWebSocketOptions
): UseSessionWebSocketResult {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const [hasConnected, setHasConnected] = useState(false)

  // WebSocket ref and connection state
  const wsRef = useRef<WebSocket | null>(null)
  const connectPromiseRef = useRef<Promise<WebSocket> | null>(null)
  const isComponentActiveRef = useRef(true)

  // Track the current session ID to ignore stale messages after session switch
  // This is updated synchronously before WebSocket cleanup to prevent race conditions
  const currentSessionIdRef = useRef(sessionId)
  currentSessionIdRef.current = sessionId

  // Keep onMessage in a ref so we don't need it as a dependency
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  // WebSocket message handler - created fresh for each session to capture sessionId
  // This ensures messages from old WebSockets are ignored after session switch
  const createMessageHandler = useCallback(
    (forSessionId: string) => (event: MessageEvent) => {
      // Ignore messages if we've switched to a different session
      // This prevents stale messages from contaminating the new session's state
      if (forSessionId !== currentSessionIdRef.current) {
        return
      }
      try {
        const data = JSON.parse(event.data)
        onMessageRef.current(data)
      } catch (error) {
        console.error('[useSessionWebSocket] Failed to parse WebSocket message:', error)
      }
    },
    []
  )

  // Lazy WebSocket connection - connects on demand with infinite retry
  // Uses exponential backoff with max delay of 60 seconds
  const ensureConnected = useCallback((): Promise<WebSocket> => {
    // If already connected, return immediately
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return Promise.resolve(wsRef.current)
    }

    // If connection in progress, return existing promise
    if (connectPromiseRef.current) {
      return connectPromiseRef.current
    }

    // Start new connection with infinite retry and exponential backoff
    const baseDelay = 1000
    const maxDelay = 60000 // 1 minute max

    connectPromiseRef.current = new Promise((resolve) => {
      let attempts = 0
      let wasConnected = false

      const tryConnect = () => {
        if (!isComponentActiveRef.current) {
          connectPromiseRef.current = null
          return
        }

        attempts++

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsUrl = `${protocol}//${window.location.host}/api/claude/sessions/${sessionId}/subscribe`

        const ws = new WebSocket(wsUrl)
        wsRef.current = ws

        ws.onopen = () => {
          setConnectionStatus('connected')
          setHasConnected(true)
          wasConnected = true
          attempts = 0 // Reset attempts on successful connection
          connectPromiseRef.current = null
          resolve(ws)
        }

        ws.onmessage = createMessageHandler(sessionId)

        ws.onerror = (error) => {
          console.error('[useSessionWebSocket] WebSocket error:', error)
        }

        ws.onclose = () => {
          // Only process if this is still the current WebSocket
          // (prevents race where old WS's onclose interferes with new connection)
          const isCurrentWs = wsRef.current === ws
          if (isCurrentWs) {
            wsRef.current = null
          }

          if (!isComponentActiveRef.current) return

          // Don't trigger reconnection if we've already started a new connection
          if (!isCurrentWs) return

          // Calculate delay with exponential backoff, capped at maxDelay
          const delay = Math.min(baseDelay * Math.pow(2, attempts - 1), maxDelay)

          if (wasConnected) {
            // Was connected, now disconnected - try token refresh then reconnect
            // Token may have expired during idle period
            setConnectionStatus('connecting')
            connectPromiseRef.current = null
            setTimeout(async () => {
              // Try to refresh auth token before reconnecting
              // This handles the case where token expired during long idle
              try {
                await refreshAccessToken()
              } catch {
                // Refresh failed, but still try to reconnect
              }
              ensureConnected()
            }, delay)
          } else if (connectPromiseRef.current) {
            // Still in initial connection phase, keep retrying
            setConnectionStatus('connecting')
            setTimeout(tryConnect, delay)
          }
        }
      }

      tryConnect()
    })

    return connectPromiseRef.current
  }, [sessionId, createMessageHandler])

  // Connect on mount, cleanup on unmount or sessionId change
  useEffect(() => {
    isComponentActiveRef.current = true
    setConnectionStatus('connecting')
    setHasConnected(false)

    // Connect immediately (infinite retry, never rejects)
    ensureConnected()

    // Handle visibility change (e.g., after laptop sleep/wake)
    // When page becomes visible, refresh token then check if WebSocket needs reconnection
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && isComponentActiveRef.current) {
        // After sleep/wake, token may have expired - try to refresh first
        // refreshAccessToken handles deduplication internally
        try {
          await refreshAccessToken()
        } catch {
          // Refresh failed, but still try to reconnect
        }

        // After sleep/wake, the WebSocket might be dead even if readyState looks OK
        // Force a reconnection check by calling ensureConnected
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          ensureConnected()
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      isComponentActiveRef.current = false
      connectPromiseRef.current = null
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
    // ensureConnected is stable for a given sessionId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Send message - connects lazily if needed
  const sendMessage = useCallback(
    async (payload: unknown) => {
      const ws = await ensureConnected()
      ws.send(JSON.stringify(payload))
    },
    [ensureConnected]
  )

  // Send raw JSON - connects lazily if needed
  const sendRaw = useCallback(
    async (json: string) => {
      const ws = await ensureConnected()
      ws.send(json)
    },
    [ensureConnected]
  )

  return {
    connectionStatus,
    hasConnected,
    sendMessage,
    sendRaw,
  }
}
