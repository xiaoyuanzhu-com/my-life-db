import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useExternalStoreRuntime } from "@assistant-ui/react"
import type {
  ThreadMessageLike,
  ExternalStoreAdapter,
  MessageStatus,
} from "@assistant-ui/react"
import type { ReadonlyJSONObject } from "assistant-stream/utils"
import {
  useAgentWebSocket,
  type AcpFrame,
  type AgentMessageChunkFrame,
  type AgentThoughtChunkFrame,
  type AgentToolCallFrame,
  type AgentToolCallUpdateFrame,
  type PermissionRequestFrame,
  type PermissionOption,
  type ErrorFrame,
} from "./use-agent-websocket"

// ── Internal State Types ──────────────────────────────────────────────

interface ToolCallPart {
  type: "tool-call"
  toolCallId: string
  toolName: string
  args: ReadonlyJSONObject
  argsText: string
  result?: unknown
  isError?: boolean
}

interface TextPart {
  type: "text"
  text: string
}

interface ReasoningPart {
  type: "reasoning"
  text: string
}

type ContentPart = TextPart | ReasoningPart | ToolCallPart

interface InternalMessage {
  id: string
  role: "user" | "assistant"
  content: ContentPart[]
  createdAt: Date
  status?: MessageStatus
}

export interface SessionMeta {
  mode?: string
  models?: string[]
  commands?: unknown[]
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useAgentRuntime(options: {
  sessionId: string
  token: string
  enabled?: boolean
  /** Override the default send behavior (e.g., to create a session on first message) */
  onSend?: (text: string) => Promise<void>
  /** Message to send automatically once the WS connects (e.g., after session creation) */
  initialMessage?: string | null
  /** Called after the initial message has been sent */
  onInitialMessageSent?: () => void
}) {
  const { sessionId, token, enabled = true, onSend, initialMessage, onInitialMessageSent } = options

  const [messages, setMessages] = useState<InternalMessage[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [sessionMeta, setSessionMeta] = useState<SessionMeta>({})
  // Map of toolCallId → { toolName, options } for pending permission.request frames
  const [pendingPermissions, setPendingPermissions] = useState<
    Map<string, { toolName: string; options: PermissionOption[] }>
  >(() => new Map())

  // Use a ref to generate stable message IDs
  const msgIdCounter = useRef(0)
  const nextId = useCallback(() => {
    msgIdCounter.current += 1
    return `msg-${msgIdCounter.current}`
  }, [])

  // ── Frame Handler ─────────────────────────────────────────────────

  const onFrame = useCallback(
    (frame: AcpFrame) => {
      switch (frame.type) {
        case "user.echo": {
          const content = (frame as AcpFrame & { content?: unknown[] }).content
          const text =
            Array.isArray(content)
              ? content
                  .filter(
                    (b): b is { type: "text"; text: string } =>
                      typeof b === "object" &&
                      b !== null &&
                      (b as { type: string }).type === "text"
                  )
                  .map((b) => b.text)
                  .join("")
              : ""

          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "user",
              content: [{ type: "text", text }],
              createdAt: new Date(frame.ts),
            },
          ])
          break
        }

        case "turn.start": {
          setIsRunning(true)
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "assistant",
              content: [],
              createdAt: new Date(frame.ts),
              status: { type: "running" },
            },
          ])
          break
        }

        case "agent.messageChunk": {
          const f = frame as AgentMessageChunkFrame
          if (f.content?.type !== "text") break
          const chunk = f.content.text

          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)
            if (!last) return prev

            const parts = [...last.content]
            const lastPart = parts[parts.length - 1]
            if (lastPart && lastPart.type === "text") {
              parts[parts.length - 1] = {
                ...lastPart,
                text: lastPart.text + chunk,
              }
            } else {
              parts.push({ type: "text", text: chunk })
            }

            replaceLastAssistant(updated, { ...last, content: parts })
            return updated
          })
          break
        }

        case "agent.thoughtChunk": {
          const f = frame as AgentThoughtChunkFrame
          if (f.content?.type !== "text") break
          const chunk = f.content.text

          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)
            if (!last) return prev

            const parts = [...last.content]
            const lastPart = parts[parts.length - 1]
            if (lastPart && lastPart.type === "reasoning") {
              parts[parts.length - 1] = {
                ...lastPart,
                text: lastPart.text + chunk,
              }
            } else {
              parts.push({ type: "reasoning", text: chunk })
            }

            replaceLastAssistant(updated, { ...last, content: parts })
            return updated
          })
          break
        }

        case "agent.toolCall": {
          const f = frame as AgentToolCallFrame
          const rawInput = f.rawInput
          const args: ReadonlyJSONObject =
            typeof rawInput === "object" && rawInput !== null
              ? (rawInput as ReadonlyJSONObject)
              : {}

          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)
            if (!last) return prev

            const parts = [...last.content]
            parts.push({
              type: "tool-call",
              toolCallId: f.toolCallId,
              toolName: f.title ?? "unknown",
              args,
              argsText: typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput ?? {}),
            })

            replaceLastAssistant(updated, { ...last, content: parts })
            return updated
          })
          break
        }

        case "agent.toolCallUpdate": {
          const f = frame as AgentToolCallUpdateFrame
          const toolCallId = f.toolCallId

          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)
            if (!last) return prev

            const parts = [...last.content]
            const idx = parts.findIndex(
              (p) => p.type === "tool-call" && p.toolCallId === toolCallId
            )
            if (idx === -1) return prev

            const existing = parts[idx] as ToolCallPart
            const patch: Partial<ToolCallPart> = {}

            if ("rawOutput" in f) {
              patch.result = f.rawOutput
            }
            if ("status" in f && f.status === "failed") {
              patch.isError = true
            }
            if ("title" in f && typeof f.title === "string") {
              patch.toolName = f.title
            }

            parts[idx] = { ...existing, ...patch }
            replaceLastAssistant(updated, { ...last, content: parts })
            return updated
          })
          break
        }

        case "permission.request": {
          const f = frame as PermissionRequestFrame
          const toolCallId = f.toolCall.toolCallId

          // Store permission options so the UI can render buttons
          setPendingPermissions((prev) => {
            const next = new Map(prev)
            next.set(toolCallId, {
              toolName: f.toolCall.title ?? "unknown",
              options: f.options,
            })
            return next
          })

          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)
            if (!last) return prev

            const parts = [...last.content]
            const idx = parts.findIndex(
              (p) => p.type === "tool-call" && p.toolCallId === toolCallId
            )

            if (idx === -1) {
              // Tool call part might not exist yet — create it
              const rawInput = f.toolCall.rawInput
              const args: ReadonlyJSONObject =
                typeof rawInput === "object" && rawInput !== null
                  ? (rawInput as ReadonlyJSONObject)
                  : {}
              parts.push({
                type: "tool-call",
                toolCallId,
                toolName: f.toolCall.title ?? "unknown",
                args,
                argsText: typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput ?? {}),
              })
            }

            const newStatus: MessageStatus = {
              type: "requires-action",
              reason: "tool-calls",
            }

            replaceLastAssistant(updated, {
              ...last,
              content: parts,
              status: newStatus,
            })
            return updated
          })
          break
        }

        case "agent.plan": {
          // Plans are metadata-only — no visible content part needed.
          // Future tasks can surface plan data via message metadata or
          // a custom data part if the UI needs to render it.
          break
        }

        case "turn.complete": {
          setIsRunning(false)
          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)
            if (!last) return prev

            replaceLastAssistant(updated, {
              ...last,
              status: { type: "complete", reason: "stop" },
            })
            return updated
          })
          break
        }

        case "error": {
          const f = frame as ErrorFrame
          setIsRunning(false)
          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)
            if (!last) return prev

            replaceLastAssistant(updated, {
              ...last,
              status: {
                type: "incomplete",
                reason: "error",
                error: f.message,
              },
            })
            return updated
          })
          break
        }

        case "session.info": {
          const isProcessing = (frame as AcpFrame & { isProcessing?: boolean })
            .isProcessing
          if (typeof isProcessing === "boolean") {
            setIsRunning(isProcessing)
          }
          break
        }

        case "session.modeUpdate": {
          const modeId = (frame as AcpFrame & { modeId?: string }).modeId
          if (modeId) {
            setSessionMeta((prev) => ({ ...prev, mode: modeId }))
          }
          break
        }

        case "session.modelsUpdate": {
          const models = (frame as AcpFrame & { models?: string[] }).models
          if (models) {
            setSessionMeta((prev) => ({ ...prev, models }))
          }
          break
        }

        case "session.commandsUpdate": {
          const commands = (frame as AcpFrame & { commands?: unknown[] })
            .commands
          if (commands) {
            setSessionMeta((prev) => ({ ...prev, commands }))
          }
          break
        }

        default:
          // Unknown frame types are silently ignored
          break
      }
    },
    [nextId]
  )

  // ── WebSocket Connection ──────────────────────────────────────────

  const { connected, sendPrompt, sendCancel, sendPermissionResponse, sendSetMode } =
    useAgentWebSocket({
      sessionId,
      token,
      onFrame,
      enabled,
    })

  // ── Send initial message once connected ──────────────────────────
  const initialMessageSentRef = useRef(false)
  useEffect(() => {
    if (connected && initialMessage && !initialMessageSentRef.current) {
      initialMessageSentRef.current = true
      sendPrompt(initialMessage)
      onInitialMessageSent?.()
    }
  }, [connected, initialMessage, sendPrompt, onInitialMessageSent])

  // ── Build ThreadMessageLike Array ─────────────────────────────────

  const threadMessages: ThreadMessageLike[] = useMemo(
    () =>
      messages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        createdAt: msg.createdAt,
        content:
          msg.content.length === 0
            ? [{ type: "text" as const, text: "" }]
            : msg.content.map((part) => {
                if (part.type === "text") {
                  return { type: "text" as const, text: part.text }
                }
                if (part.type === "reasoning") {
                  return { type: "reasoning" as const, text: part.text }
                }
                // tool-call
                return {
                  type: "tool-call" as const,
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  args: part.args,
                  result: part.result,
                  isError: part.isError,
                }
              }),
        status: msg.status,
      })),
    [messages]
  )

  // ── ExternalStoreAdapter ──────────────────────────────────────────

  const adapter: ExternalStoreAdapter<ThreadMessageLike> = useMemo(
    () => ({
      messages: threadMessages,
      isRunning,
      convertMessage: (msg: ThreadMessageLike) => msg,
      onNew: async (message) => {
        // Extract text from the AppendMessage content parts
        const textParts = message.content.filter(
          (p): p is { type: "text"; text: string } => p.type === "text"
        )
        const text = textParts.map((p) => p.text).join("\n")
        if (text.trim()) {
          if (onSend) {
            await onSend(text)
          } else {
            sendPrompt(text)
          }
        }
      },
      onCancel: async () => {
        sendCancel()
      },
    }),
    [threadMessages, isRunning, onSend, sendPrompt, sendCancel]
  )

  // ── Runtime ───────────────────────────────────────────────────────

  const runtime = useExternalStoreRuntime(adapter)

  // Wrap sendPermissionResponse to also clear the pending entry
  const handlePermissionResponse = useCallback(
    (toolCallId: string, optionId: string) => {
      sendPermissionResponse(toolCallId, optionId)
      setPendingPermissions((prev) => {
        const next = new Map(prev)
        next.delete(toolCallId)
        return next
      })
    },
    [sendPermissionResponse]
  )

  return {
    runtime,
    connected,
    sessionMeta,
    pendingPermissions,
    sendPermissionResponse: handlePermissionResponse,
    sendSetMode,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function findLastAssistant(
  messages: InternalMessage[]
): InternalMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i]
  }
  return undefined
}

function replaceLastAssistant(
  messages: InternalMessage[],
  replacement: InternalMessage
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      messages[i] = replacement
      return
    }
  }
}
