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
  type SessionInfoFrame,
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
  isOptimistic?: boolean
}

export interface SessionMeta {
  mode?: string
  availableModes?: unknown[]
  currentModel?: string
  availableModels?: unknown[]
  commands?: unknown[]
}

export interface PlanEntry {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed"
  priority?: string
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useAgentRuntime(options: {
  sessionId: string
  token: string
  enabled?: boolean
  /** When provided, onNew calls this instead of sendPrompt (used for new-session creation) */
  onSend?: (text: string) => void
}) {
  const { sessionId, token, enabled = true, onSend } = options

  const [messages, setMessages] = useState<InternalMessage[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [sessionMeta, setSessionMeta] = useState<SessionMeta>({})
  const [planEntries, setPlanEntries] = useState<PlanEntry[]>([])
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

  // Burst replay dedup: when session.info arrives and we already have messages,
  // skip exactly totalMessages replayed frames (count-based, not flag-based).
  const burstRemainingRef = useRef(0)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // ── Frame Handler ─────────────────────────────────────────────────

  const onFrame = useCallback(
    (frame: AcpFrame) => {
      // Burst replay dedup: on reconnect, session.info tells us how many
      // frames will be replayed. Skip exactly that many if we already have messages.
      if (frame.type === "session.info") {
        const info = frame as SessionInfoFrame
        if (messagesRef.current.length > 0 && info.totalMessages > 0) {
          burstRemainingRef.current = info.totalMessages
        }
        // Fall through to handle session.info normally below
      } else if (burstRemainingRef.current > 0) {
        burstRemainingRef.current--
        return // skip burst replay frame
      }

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

          setMessages((prev) => {
            // Check if there's an optimistic user message with matching text
            const optimisticIdx = prev.findIndex(
              (m) =>
                m.role === "user" &&
                m.isOptimistic &&
                m.content.some((p) => p.type === "text" && p.text === text)
            )
            if (optimisticIdx !== -1) {
              // Replace optimistic message with server-confirmed one
              const updated = [...prev]
              updated[optimisticIdx] = {
                ...updated[optimisticIdx],
                createdAt: new Date(),
                isOptimistic: false,
              }
              return updated
            }
            // No optimistic match — add normally
            return [
              ...prev,
              {
                id: nextId(),
                role: "user",
                content: [{ type: "text", text }],
                createdAt: new Date(),
              },
            ]
          })
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
              createdAt: new Date(),
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
          const rawInput = (f.rawInput ?? {}) as Record<string, unknown>
          // Include kind from the frame so tool renderers can dispatch on it
          const args = { ...rawInput, kind: f.kind } as ReadonlyJSONObject

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

          // Clear pending permission for this tool call (it has a result now)
          setPendingPermissions((prev) => {
            if (!prev.has(toolCallId)) return prev
            const next = new Map(prev)
            next.delete(toolCallId)
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

          // Check if this tool call already has a result (e.g., during burst replay
          // after page refresh where permission.request arrives before toolCallUpdate
          // but both are in the burst). If the tool call already completed, skip.
          const alreadyResolved = messagesRef.current.some((m) =>
            m.role === "assistant" &&
            m.content.some(
              (p) => p.type === "tool-call" && p.toolCallId === toolCallId && p.result !== undefined
            )
          )
          if (alreadyResolved) break

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
          const entries = (frame as AcpFrame & { entries?: unknown[] }).entries
          if (Array.isArray(entries)) {
            const parsed: PlanEntry[] = entries
              .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
              .map((e, i) => ({
                id: typeof e.id === "string" ? e.id : `plan-${i}`,
                content: typeof e.content === "string" ? e.content : String(e.content ?? ""),
                status: (e.status === "in_progress" || e.status === "completed")
                  ? e.status as PlanEntry["status"]
                  : "pending",
                priority: typeof e.priority === "string" ? e.priority : undefined,
              }))
            setPlanEntries(parsed)
          }
          break
        }

        case "turn.complete": {
          setIsRunning(false)
          // Clear all pending permissions — the turn is done
          setPendingPermissions((prev) => {
            if (prev.size === 0) return prev
            return new Map()
          })
          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)
            if (!last) return prev

            // Mark any tool calls without results as complete.
            // Some tools (e.g., WebSearch) may not send rawOutput in
            // toolCallUpdate, leaving result undefined. Without this,
            // assistant-ui keeps their status as "running" even after
            // the turn ends.
            const content = last.content.map((part) => {
              if (part.type === "tool-call" && part.result === undefined) {
                return { ...part, result: "" }
              }
              return part
            })

            replaceLastAssistant(updated, {
              ...last,
              content,
              status: { type: "complete", reason: "stop" },
            })
            return updated
          })
          break
        }

        case "error": {
          const f = frame as ErrorFrame
          setIsRunning(false)
          // Clear all pending permissions on error — the turn is done
          setPendingPermissions((prev) => {
            if (prev.size === 0) return prev
            return new Map()
          })
          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)
            if (!last) return prev

            // Mark incomplete tool calls as errored
            const content = last.content.map((part) => {
              if (part.type === "tool-call" && part.result === undefined) {
                return { ...part, result: "", isError: true }
              }
              return part
            })

            replaceLastAssistant(updated, {
              ...last,
              content,
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
            // If the session is not processing, clear any stale pending permissions
            if (!isProcessing) {
              setPendingPermissions((prev) => {
                if (prev.size === 0) return prev
                return new Map()
              })
            }
          }
          break
        }

        case "session.modeUpdate": {
          const f = frame as AcpFrame & { modeId?: string; availableModes?: unknown[] }
          const update: Partial<SessionMeta> = {}
          if (f.modeId) update.mode = f.modeId
          if (f.availableModes) update.availableModes = f.availableModes
          if (Object.keys(update).length > 0) {
            setSessionMeta((prev) => ({ ...prev, ...update }))
          }
          break
        }

        case "session.modelsUpdate": {
          const f = frame as AcpFrame & { modelId?: string; availableModels?: unknown[] }
          const update: Partial<SessionMeta> = {}
          if (f.modelId) update.currentModel = f.modelId
          if (f.availableModels) update.availableModels = f.availableModels
          if (Object.keys(update).length > 0) {
            setSessionMeta((prev) => ({ ...prev, ...update }))
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
        metadata: msg.isOptimistic ? { custom: { isOptimistic: true } } : undefined,
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
            // Route to parent handler (e.g., create session via API)
            onSend(text)
          } else {
            // Add optimistic user message immediately
            setMessages((prev) => [
              ...prev,
              {
                id: nextId(),
                role: "user",
                content: [{ type: "text", text }],
                createdAt: new Date(),
                isOptimistic: true,
              },
            ])
            sendPrompt(text)
          }
        }
      },
      onCancel: async () => {
        sendCancel()
      },
    }),
    [threadMessages, isRunning, sendPrompt, sendCancel, onSend]
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
    planEntries,
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
