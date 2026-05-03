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
  agentType?: string
  /** Baseline configOptions for agents that don't emit ACP config_option_update. */
  defaultConfigOptions?: Array<{
    id: string
    category: string
    name?: string
    description?: string
    currentValue: string
    options: Array<{ value: string; name: string; description: string }>
  }>
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
  // Incremented to force a clean disconnect/reconnect cycle (e.g. after session restart)
  const [reconnectKey, setReconnectKey] = useState(0)

  // Use a ref for onFrame to prevent WS reconnects when the callback changes
  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame

  // Stable getters for diagnostics — let callers (use-agent-runtime) read
  // the live ws state at the moment they trigger a send, instead of relying
  // on the React `connected` boolean which can lag behind an actual close.
  const getReadyState = useCallback((): number => {
    return wsRef.current?.readyState ?? -1
  }, [])
  const getBufferedAmount = useCallback((): number => {
    return wsRef.current?.bufferedAmount ?? 0
  }, [])

  const send = useCallback((msg: Record<string, unknown>): boolean => {
    const ws = wsRef.current
    const ready = ws?.readyState ?? -1
    const buffered = ws?.bufferedAmount ?? 0
    const msgType = String(msg.type ?? "?")
    if (ws && ready === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...msg, sessionId }))
      console.info(
        `[ws-send] [${sessionId}] type=${msgType} success=true ready=${ready} bufferedBefore=${buffered} bufferedAfter=${ws.bufferedAmount}`,
      )
      return true
    }
    console.info(
      `[ws-send] [${sessionId}] type=${msgType} success=false ready=${ready} buffered=${buffered} (wsRef=${ws ? "set" : "null"})`,
    )
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

  const sendSetConfigOption = useCallback((configId: string, configValue: string) => {
    send({ type: "session.setConfigOption", configId, configValue })
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

      console.info(
        `[ws-conn] [${sessionId}] connecting url=${url.replace(/token=[^&]+/, "token=***")}`,
      )

      thisWs.onopen = () => {
        const stale = wsRef.current !== thisWs
        console.info(
          `[ws-conn] [${sessionId}] open stale=${stale} ready=${thisWs.readyState}`,
        )
        if (stale) return
        setConnected(true)
        reconnectDelay = 1000 // reset on successful connect
      }

      thisWs.onclose = (ev) => {
        const isCurrent = wsRef.current === thisWs
        console.info(
          `[ws-conn] [${sessionId}] close isCurrent=${isCurrent} code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean} unmounted=${unmounted} nextDelay=${unmounted ? 0 : reconnectDelay}`,
        )
        if (isCurrent) {
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

      thisWs.onerror = (ev) => {
        console.info(
          `[ws-conn] [${sessionId}] error ready=${thisWs.readyState} type=${ev.type}`,
        )
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
  }, [sessionId, token, enabled, reconnectKey])

  const reconnect = useCallback(() => {
    setReconnectKey((k) => k + 1)
  }, [])

  return { connected, sendPrompt, sendCancel, sendKill, sendPermissionResponse, sendSetMode, sendSetModel, sendSetConfigOption, getReadyState, getBufferedAmount, reconnect }
}
