import { useCallback, useEffect, useRef, useState } from "react"

// ACP envelope frame — every WS message has this shape
export interface AcpFrame {
  type: string
  [key: string]: unknown
}

// ACP ContentBlock (tagged union)
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string }

// Tool call fields
export interface ToolCallFields {
  toolCallId: string
  title?: string
  kind?: string
  status?: string
  content?: unknown[]
  locations?: Array<{ path: string; line?: number }>
  rawInput?: unknown
  rawOutput?: unknown
}

// Permission option
export interface PermissionOption {
  optionId: string
  name: string
  kind: string
}

// Specific frame types
export interface SessionInfoFrame extends AcpFrame {
  type: "session.info"
  totalMessages: number
  isProcessing: boolean
}

export interface AgentMessageChunkFrame extends AcpFrame {
  type: "agent.messageChunk"
  content: ContentBlock
}

export interface AgentThoughtChunkFrame extends AcpFrame {
  type: "agent.thoughtChunk"
  content: ContentBlock
}

export interface AgentToolCallFrame extends AcpFrame, ToolCallFields {
  type: "agent.toolCall"
}

export interface AgentToolCallUpdateFrame extends AcpFrame {
  type: "agent.toolCallUpdate"
  toolCallId: string
  [key: string]: unknown  // optional patch fields
}

export interface PermissionRequestFrame extends AcpFrame {
  type: "permission.request"
  toolCall: ToolCallFields
  options: PermissionOption[]
}

export interface TurnCompleteFrame extends AcpFrame {
  type: "turn.complete"
  stopReason: string
}

export interface ErrorFrame extends AcpFrame {
  type: "error"
  message: string
  code?: string
}

export type AgentFrame =
  | SessionInfoFrame
  | AgentMessageChunkFrame
  | AgentThoughtChunkFrame
  | AgentToolCallFrame
  | AgentToolCallUpdateFrame
  | PermissionRequestFrame
  | TurnCompleteFrame
  | ErrorFrame
  | AcpFrame  // catch-all for unknown types

interface UseAgentWebSocketOptions {
  sessionId: string
  token: string
  onFrame: (frame: AcpFrame) => void
  enabled?: boolean
}

export function useAgentWebSocket({
  sessionId,
  token,
  onFrame,
  enabled = true,
}: UseAgentWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)

  // Use a ref for onFrame to prevent WS reconnects when the callback changes
  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame

  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ ...msg, sessionId }))
    }
  }, [sessionId])

  const sendPrompt = useCallback((text: string) => {
    send({ type: "session.prompt", content: [{ type: "text", text }] })
  }, [send])

  const sendCancel = useCallback(() => {
    send({ type: "session.cancel" })
  }, [send])

  const sendPermissionResponse = useCallback((toolCallId: string, optionId: string) => {
    send({ type: "permission.respond", toolCallId, optionId })
  }, [send])

  const sendSetMode = useCallback((modeId: string) => {
    send({ type: "session.setMode", modeId })
  }, [send])

  useEffect(() => {
    if (!enabled || !sessionId) return

    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectDelay = 1000 // start at 1s
    let unmounted = false

    function connect() {
      if (unmounted) return

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
      const url = `${protocol}//${window.location.host}/api/agent/sessions/${sessionId}/subscribe?token=${token}`

      ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        reconnectDelay = 1000 // reset on successful connect
      }

      ws.onclose = () => {
        setConnected(false)
        wsRef.current = null
        // Reconnect with exponential backoff
        if (!unmounted) {
          reconnectTimer = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 30000)
            connect()
          }, reconnectDelay)
        }
      }

      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data) as AcpFrame
          onFrameRef.current(frame)
        } catch {
          // ignore malformed frames
        }
      }
    }

    connect()

    return () => {
      unmounted = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) ws.close()
      wsRef.current = null
      setConnected(false)
    }
  }, [sessionId, token, enabled])

  return { connected, sendPrompt, sendCancel, sendPermissionResponse, sendSetMode }
}
