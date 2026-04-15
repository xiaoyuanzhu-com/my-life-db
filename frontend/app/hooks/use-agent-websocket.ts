import { useCallback, useEffect, useRef, useState } from "react"

// ACP envelope frame — two possible discriminators
export interface AcpFrame {
  // ACP native frames use sessionUpdate as discriminator
  sessionUpdate?: string
  // Synthesized frames use type as discriminator
  type?: string
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
  content?: unknown[]
  locations?: Array<{ path: string; line?: number }>
  rawInput?: unknown
  rawOutput?: unknown
  status?: string // ACP provides this natively on tool_call and tool_call_update
}

// Permission option
export interface PermissionOption {
  optionId: string
  name: string
  kind: string
}

// Specific frame types — ACP native frames (sessionUpdate discriminator)

export interface AgentMessageChunkFrame extends AcpFrame {
  sessionUpdate: "agent_message_chunk"
  content: ContentBlock
}

export interface AgentThoughtChunkFrame extends AcpFrame {
  sessionUpdate: "agent_thought_chunk"
  content: ContentBlock
}

export interface AgentToolCallFrame extends AcpFrame, ToolCallFields {
  sessionUpdate: "tool_call"
}

export interface AgentToolCallUpdateFrame extends AcpFrame {
  sessionUpdate: "tool_call_update"
  toolCallId: string
  [key: string]: unknown // optional patch fields
}

export interface UserMessageChunkFrame extends AcpFrame {
  sessionUpdate: "user_message_chunk"
  content: ContentBlock
}

export interface PlanFrame extends AcpFrame {
  sessionUpdate: "plan"
  entries: unknown[]
}

export interface CurrentModeUpdateFrame extends AcpFrame {
  sessionUpdate: "current_mode_update"
  currentModeId: string
}

export interface AvailableCommandsUpdateFrame extends AcpFrame {
  sessionUpdate: "available_commands_update"
  availableCommands: unknown[]
}

// Specific frame types — synthesized frames (type discriminator)

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

export interface SessionInfoFrame extends AcpFrame {
  type: "session.info"
  totalMessages?: number
  isActive: boolean
  isProcessing: boolean
}

export type AgentFrame =
  | SessionInfoFrame
  | AgentMessageChunkFrame
  | AgentThoughtChunkFrame
  | AgentToolCallFrame
  | AgentToolCallUpdateFrame
  | UserMessageChunkFrame
  | PlanFrame
  | CurrentModeUpdateFrame
  | AvailableCommandsUpdateFrame
  | PermissionRequestFrame
  | TurnCompleteFrame
  | ErrorFrame
  | AcpFrame // catch-all for unknown types

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

  const send = useCallback((msg: Record<string, unknown>): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ ...msg, sessionId }))
      return true
    }
    return false
  }, [sessionId])

  const sendPrompt = useCallback((text: string): boolean => {
    return send({ type: "session.prompt", content: [{ type: "text", text }] })
  }, [send])

  const sendCancel = useCallback(() => {
    send({ type: "session.cancel" })
  }, [send])

  const sendKill = useCallback(() => {
    send({ type: "session.kill" })
  }, [send])

  const sendPermissionResponse = useCallback((toolCallId: string, optionId: string) => {
    send({ type: "permission.respond", toolCallId, optionId })
  }, [send])

  const sendSetMode = useCallback((modeId: string) => {
    send({ type: "session.setMode", modeId })
  }, [send])

  const sendSetModel = useCallback((modelId: string) => {
    send({ type: "session.setModel", modelId })
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

      // Capture this specific instance so async handlers (onopen/onclose)
      // only mutate shared state when they belong to the current connection.
      // Without this guard, a stale onclose from a previous session's WS
      // fires after the new WS is set up and wipes wsRef.current to null,
      // silently breaking send() for the new session.
      const thisWs = new WebSocket(url)
      ws = thisWs
      wsRef.current = thisWs

      thisWs.onopen = () => {
        if (wsRef.current !== thisWs) return
        setConnected(true)
        reconnectDelay = 1000 // reset on successful connect
      }

      thisWs.onclose = () => {
        if (wsRef.current === thisWs) {
          setConnected(false)
          wsRef.current = null
        }
        // Reconnect with exponential backoff
        if (!unmounted) {
          reconnectTimer = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 30000)
            connect()
          }, reconnectDelay)
        }
      }

      thisWs.onmessage = (event) => {
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

  return { connected, sendPrompt, sendCancel, sendKill, sendPermissionResponse, sendSetMode, sendSetModel }
}
