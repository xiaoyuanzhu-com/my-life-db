import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useParams } from 'react-router'
import { MessageList } from '~/components/claude/_archived-chat'
import {
  buildToolResultMap,
  normalizeMessage,
  hasToolUseResult,
  type SessionMessage,
} from '~/lib/session-message-utils'
import '@fontsource/jetbrains-mono'

const SKIP_TYPES = ['file-history-snapshot', 'result']

interface ShareMetadata {
  sessionId: string
  title: string
  createdAt: string
}

export default function SharePage() {
  const { token } = useParams()
  const [metadata, setMetadata] = useState<ShareMetadata | null>(null)
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const messageQueueRef = useRef<unknown[]>([])
  const processRafRef = useRef<number | null>(null)

  // Fetch session metadata
  useEffect(() => {
    if (!token) return

    fetch(`/api/share/${token}`)
      .then(async (res) => {
        if (res.status === 404) {
          setError('This shared session is no longer available.')
          setLoading(false)
          return
        }
        if (!res.ok) {
          setError(`Failed to load shared session (${res.status}).`)
          setLoading(false)
          return
        }
        const data = await res.json()
        setMetadata(data)
      })
      .catch(() => {
        setError('Failed to load shared session.')
        setLoading(false)
      })
  }, [token])

  // Process a single incoming message
  const processMessage = useCallback((data: unknown) => {
    const msg = data as Record<string, unknown>

    // Skip session_info metadata
    if (msg.type === 'session_info') return

    // Skip internal transport types
    if (msg.type === 'queue-operation' || msg.type === 'file-history-snapshot') return

    // Skip error messages (just log)
    if (msg.type === 'error') {
      console.error('[SharePage] Error from server:', msg.error)
      return
    }

    // Skip stream_event, progress, todo_update, control_* types
    if (
      msg.type === 'stream_event' ||
      msg.type === 'progress' ||
      msg.type === 'todo_update' ||
      msg.type === 'control_request' ||
      msg.type === 'control_response'
    ) {
      return
    }

    const normalized = normalizeMessage(msg) as unknown as SessionMessage
    if (!normalized.uuid) return

    setMessages((prev) => {
      // Dedup by uuid - replace existing or append
      const idx = prev.findIndex((m) => m.uuid === normalized.uuid)
      if (idx >= 0) {
        const updated = [...prev]
        updated[idx] = normalized
        return updated
      }
      return [...prev, normalized]
    })
  }, [])

  // Batched message processing (same pattern as ChatInterface)
  const flushMessageQueue = useCallback(() => {
    processRafRef.current = null
    const batch = messageQueueRef.current
    messageQueueRef.current = []
    for (const msg of batch) {
      processMessage(msg)
    }
  }, [processMessage])

  // Connect to WebSocket
  useEffect(() => {
    if (!token || !metadata) return

    setLoading(false)

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/share/${token}/subscribe`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        messageQueueRef.current.push(data)
        if (processRafRef.current === null) {
          processRafRef.current = requestAnimationFrame(flushMessageQueue)
        }
      } catch (err) {
        console.error('[SharePage] Failed to parse WebSocket message:', err)
      }
    }

    ws.onerror = () => {
      console.error('[SharePage] WebSocket error')
    }

    ws.onclose = () => {
      wsRef.current = null
    }

    return () => {
      if (processRafRef.current !== null) {
        cancelAnimationFrame(processRafRef.current)
        processRafRef.current = null
      }
      ws.close()
      wsRef.current = null
    }
  }, [token, metadata, flushMessageQueue])

  // Filter messages for rendering
  const filteredMessages = useMemo(() => {
    return messages.filter((msg) => {
      if (SKIP_TYPES.includes(msg.type)) return false
      if (msg.type === 'control_request' || msg.type === 'control_response') return false
      if (msg.type === 'user' && hasToolUseResult(msg)) return false
      return true
    })
  }, [messages])

  // Build tool result map
  const toolResultMap = useMemo(() => {
    return buildToolResultMap(messages)
  }, [messages])

  // Loading state
  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-foreground">
        <p className="text-muted-foreground">Loading shared session...</p>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-foreground">
        <p className="text-destructive">{error}</p>
      </div>
    )
  }

  const title = metadata?.title || 'Shared Session'

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
          Shared session
        </span>
      </div>

      {/* Message list */}
      <div className="min-h-0 flex-1">
        <MessageList
          messages={filteredMessages}
          toolResultMap={toolResultMap}
        />
      </div>
    </div>
  )
}
