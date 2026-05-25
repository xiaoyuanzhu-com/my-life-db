import { useCallback, useEffect, useRef, useState } from "react"
import { refreshAccessToken } from "~/lib/fetch-with-refresh"

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
  /**
   * Optional id echoed back from the prompt that produced this chunk.
   * Present only when the originating session.prompt carried one — historical
   * sessions replayed via LoadSession predate this and won't have it.
   */
  messageId?: string
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
  /** Source of the session: "user" or "auto" */
  source?: string
  /** Outcome of the last completed turn — empty when no turn has occurred. */
  lastTurnOutcome?: '' | 'completed' | 'cancelled' | 'interrupted' | 'errored'
  /** Unix ms timestamp when the last outcome was recorded. */
  lastTurnOutcomeAt?: number
  /** Populated only when lastTurnOutcome === 'errored'. */
  lastErrorMessage?: string
  /** The last prompt text that was in-flight (used for Resume). */
  lastPromptText?: string
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
  /**
   * Fired when the WebSocket closes with a code that signals a
   * protocol-level failure the next reconnect cannot fix on its own — today
   * just `1009` (Message Too Big). The reconnect itself still proceeds,
   * but the runtime needs this hook to mark whichever outbox items were
   * inflight as failed; otherwise the outbox would re-queue them, the
   * server would close again on the same oversize frame, and the loop
   * would never settle.
   */
  onPermanentClose?: (info: { code: number; reason: string }) => void
}

export function useAgentWebSocket({
  sessionId,
  token,
  onFrame,
  enabled = true,
  onPermanentClose,
}: UseAgentWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  // Incremented to force a clean disconnect/reconnect cycle (e.g. after session restart)
  const [reconnectKey, setReconnectKey] = useState(0)

  // Use a ref for onFrame to prevent WS reconnects when the callback changes
  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame

  // Mirror onPermanentClose into a ref so the close handler always sees the
  // latest closure without forcing a tear-down/reconnect of the WS itself.
  const onPermanentCloseRef = useRef(onPermanentClose)
  onPermanentCloseRef.current = onPermanentClose

  // DIAG: identify which WS effect dep is flipping on mount (causing the
  // first WS to be torn down before its handshake completes — manifests as
  // the "WebSocket is closed before the connection is established" warning).
  // Remove once the root cause is identified and fixed.
  const effectRunRef = useRef(0)
  const prevDepsRef = useRef<{
    sessionId: string
    token: string
    enabled: boolean
    reconnectKey: number
  } | null>(null)

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

  const sendPrompt = useCallback(
    (text: string, messageId?: string): boolean => {
      const msg: Record<string, unknown> = {
        type: "session.prompt",
        content: [{ type: "text", text }],
      }
      // Wire-frame field is optional: not all callers carry an outbox-issued
      // id (e.g. legacy paths), and historical frames replayed by LoadSession
      // won't have one either.
      if (messageId) msg.messageId = messageId
      return send(msg)
    },
    [send],
  )

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
    // DIAG: log every effect run with the dep diff. Helps identify which dep
    // is flipping on mount. Remove once the root cause is fixed.
    const runIdx = ++effectRunRef.current
    const prev = prevDepsRef.current
    const curr = { sessionId, token, enabled, reconnectKey }
    const changed = prev
      ? (Object.keys(curr) as Array<keyof typeof curr>)
          .filter((k) => prev[k] !== curr[k])
          .map((k) => `${k}: ${JSON.stringify(prev[k])} → ${JSON.stringify(curr[k])}`)
      : ['<initial>']
    console.info(
      `[ws-conn] [${sessionId}] effect run=${runIdx} changed=[${changed.join(', ')}]`,
    )
    prevDepsRef.current = curr

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
        // 1009 (Message Too Big) is the only close code our server sends
        // that survives a reconnect: whatever frame triggered it is still
        // queued in the outbox and would re-flush on the next open, closing
        // the socket again on the same byte. Notify the runtime *before*
        // arming the reconnect so it can mark inflight items failed —
        // outbox.connectionChanged("closed") (fired by the runtime's
        // [connected] effect on the next render) would otherwise demote
        // them back to pending and they'd re-flush on open.
        if (ev.code === 1009 && onPermanentCloseRef.current) {
          try {
            onPermanentCloseRef.current({ code: ev.code, reason: ev.reason })
          } catch (err) {
            console.error(`[ws-conn] [${sessionId}] onPermanentClose handler threw`, err)
          }
        }
        // Reconnect with exponential backoff. Refresh the access token first —
        // the cookie may have expired while the tab was idle, in which case
        // every reconnect attempt would 401 at the gateway forever (cookies
        // get sent automatically with WS upgrades, but expired ones don't
        // self-renew like fetchWithRefresh does for HTTP).
        if (!unmounted) {
          reconnectTimer = setTimeout(async () => {
            reconnectDelay = Math.min(reconnectDelay * 2, 30000)
            try {
              await refreshAccessToken()
            } catch {
              // Refresh failed — still try to reconnect, the cookie may
              // have been updated by another tab or the native shell.
            }
            if (!unmounted) connect()
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

    // Wake the WS immediately when the tab becomes visible again, instead of
    // waiting for the backoff timer (which can be up to 30s after a long idle).
    // Refresh the token first so the reconnect picks up a fresh cookie.
    const onVisibility = async () => {
      if (document.visibilityState !== "visible" || unmounted) return
      const ready = wsRef.current?.readyState ?? -1
      if (ready === WebSocket.OPEN || ready === WebSocket.CONNECTING) return
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      try {
        await refreshAccessToken()
      } catch {
        // Still try to reconnect — cookie may be valid via another path.
      }
      if (!unmounted) {
        reconnectDelay = 1000
        connect()
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      unmounted = true
      document.removeEventListener("visibilitychange", onVisibility)
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
