import { useCallback, useMemo, useRef, useState } from "react"
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
  type UserMessageChunkFrame,
  type SessionInfoFrame,
  type PermissionRequestFrame,
  type PermissionOption,
  type ErrorFrame,
  type ToolCallFields,
} from "./use-agent-websocket"
import { isSkippedXmlContent } from "~/lib/session-message-utils"

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
  /** Thread list data — when provided, powers the assistant-ui ThreadList component */
  sessions?: Array<{
    id: string
    title?: string
    summary?: string
    sessionState: string
  }>
  activeSessionId?: string | null
  onSwitchToThread?: (id: string) => void
  onSwitchToNewThread?: () => void
  onRenameThread?: (id: string, title: string) => void
  onArchiveThread?: (id: string) => void
  onUnarchiveThread?: (id: string) => void
  onDeleteThread?: (id: string) => void
}) {
  const {
    sessionId,
    token,
    enabled = true,
    onSend,
    sessions,
    activeSessionId,
    onSwitchToThread,
    onSwitchToNewThread,
    onRenameThread,
    onArchiveThread,
    onUnarchiveThread,
    onDeleteThread,
  } = options

  const [messages, setMessages] = useState<InternalMessage[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [sessionMeta, setSessionMeta] = useState<SessionMeta>({})
  const [planEntries, setPlanEntries] = useState<PlanEntry[]>([])
  // Map of toolCallId → { toolName, options } for pending permission.request frames
  const [pendingPermissions, setPendingPermissions] = useState<
    Map<string, { toolName: string; options: PermissionOption[] }>
  >(() => new Map())
  // Set when backend signals history loading is complete but no messages arrived
  const [historyLoadError, setHistoryLoadError] = useState<string | null>(null)
  // Set when a live session errors before any message can render
  const [sessionError, setSessionError] = useState<string | null>(null)

  // Reset all per-session state when switching sessions
  const prevSessionIdRef = useRef(sessionId)
  if (prevSessionIdRef.current !== sessionId) {
    prevSessionIdRef.current = sessionId
    setMessages([])
    setIsRunning(false)
    setSessionMeta({})
    setPlanEntries([])
    setPendingPermissions(new Map())
    setHistoryLoadError(null)
    setSessionError(null)
  }

  // Whether the session is active (loaded via ACP + at least one prompt sent).
  // Populated from backend's session.info frame on WS connect (source of truth).
  // Inactive sessions never show "working"; active sessions rely on turn.complete.
  const isActiveRef = useRef(false)

  // Use a ref to generate stable message IDs
  const msgIdCounter = useRef(0)
  const nextId = useCallback(() => {
    msgIdCounter.current += 1
    return `msg-${msgIdCounter.current}`
  }, [])

  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // ── Frame Handler ─────────────────────────────────────────────────

  const onFrame = useCallback(
    (frame: AcpFrame) => {
      // Route by discriminator: ACP native frames use sessionUpdate,
      // synthesized frames use type
      const frameType = frame.sessionUpdate || frame.type

      switch (frameType) {
        case "session.info": {
          const f = frame as SessionInfoFrame
          isActiveRef.current = f.isActive
          break
        }

        case "session.historyDone": {
          const error = (frame as AcpFrame & { error?: string }).error
          if (error) {
            setHistoryLoadError(error)
          } else {
            setHistoryLoadError("Session history unavailable")
          }
          break
        }

        case "user_message_chunk": {
          setSessionError(null)
          // ACP native: content is a single content block, not an array
          const f = frame as UserMessageChunkFrame
          const text = f.content?.type === "text" ? f.content.text || "" : ""

          // Skip empty/whitespace-only messages (e.g., non-text content blocks,
          // system-injected messages with no visible text) and system-injected
          // messages (slash commands, task notifications containing only XML tags).
          if (!text.trim() || isSkippedXmlContent(text) || text.trimStart().startsWith("<task-notification>")) {
            break
          }

          setMessages((prev) => {
            // Check if there's an optimistic user message with matching text
            const optimisticIdx = prev.findIndex(
              (m) =>
                m.role === "user" &&
                m.isOptimistic &&
                m.content.some((p) => p.type === "text" && p.text === text)
            )
            if (optimisticIdx !== -1) {
              const updated = [...prev]
              updated[optimisticIdx] = {
                ...updated[optimisticIdx],
                createdAt: new Date(),
                isOptimistic: false,
              }
              return updated
            }

            const updated = [...prev]

            // During replay (session not active), close any running assistant
            // message. ACP replay has no turn.complete — user_message_chunk
            // is the only turn boundary signal.
            if (!isActiveRef.current) {
              const lastAssistant = findLastAssistant(updated)
              if (lastAssistant && lastAssistant.status?.type !== "complete") {
                const content = lastAssistant.content.map((part) => {
                  if (part.type === "tool-call" && part.result === undefined) {
                    return { ...part, result: "" }
                  }
                  return part
                })
                replaceLastAssistant(updated, {
                  ...lastAssistant,
                  content,
                  status: { type: "complete", reason: "stop" },
                })
              }
            }

            updated.push({
              id: nextId(),
              role: "user",
              content: [{ type: "text", text }],
              createdAt: new Date(),
            })
            return updated
          })
          break
        }

        case "agent_message_chunk": {
          setSessionError(null)
          const f = frame as AgentMessageChunkFrame
          if (f.content?.type !== "text") break
          const chunk = f.content.text

          if (isActiveRef.current) setIsRunning(true)
          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)

            // If no open assistant message exists, create one.
            // Active sessions use "running" (triggers WIP indicator);
            // inactive (replay) use "incomplete" (allows appending without triggering running).
            if (!last || last.status?.type === "complete") {
              // Don't create a new assistant message from an empty text chunk
              if (!chunk) return prev
              updated.push({
                id: nextId(),
                role: "assistant",
                content: [{ type: "text", text: chunk }],
                createdAt: new Date(),
                status: isActiveRef.current
                  ? { type: "running" }
                  : { type: "incomplete", reason: "other" },
              })
              return updated
            }

            const parts = [...last.content]
            const lastPart = parts[parts.length - 1]
            if (lastPart && lastPart.type === "text") {
              parts[parts.length - 1] = {
                ...lastPart,
                text: lastPart.text + chunk,
              }
            } else {
              // Don't append an empty text part after non-text content (e.g., tool call)
              if (!chunk) return prev
              parts.push({ type: "text", text: chunk })
            }

            replaceLastAssistant(updated, { ...last, content: parts })
            return updated
          })
          break
        }

        case "agent_thought_chunk": {
          setSessionError(null)
          const f = frame as AgentThoughtChunkFrame
          if (f.content?.type !== "text") break
          const chunk = f.content.text

          if (isActiveRef.current) setIsRunning(true)
          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)

            if (!last || last.status?.type === "complete") {
              // Don't create a new assistant message from an empty thought chunk
              if (!chunk) return prev
              updated.push({
                id: nextId(),
                role: "assistant",
                content: [{ type: "reasoning", text: chunk }],
                createdAt: new Date(),
                status: isActiveRef.current
                  ? { type: "running" }
                  : { type: "incomplete", reason: "other" },
              })
              return updated
            }

            const parts = [...last.content]
            const lastPart = parts[parts.length - 1]
            if (lastPart && lastPart.type === "reasoning") {
              parts[parts.length - 1] = {
                ...lastPart,
                text: lastPart.text + chunk,
              }
            } else {
              // Don't append an empty reasoning part after non-reasoning content
              if (!chunk) return prev
              parts.push({ type: "reasoning", text: chunk })
            }

            replaceLastAssistant(updated, { ...last, content: parts })
            return updated
          })
          break
        }

        case "tool_call": {
          setSessionError(null)
          const f = frame as AgentToolCallFrame
          const rawInput = (f.rawInput ?? {}) as Record<string, unknown>
          // Include kind from the frame so tool renderers can dispatch on it.
          // Extract _meta.claudeCode.toolName for display label (e.g., "Bash").
          const meta = f._meta as Record<string, unknown> | undefined
          const claudeMeta = meta?.claudeCode as Record<string, unknown> | undefined
          const metaToolName = typeof claudeMeta?.toolName === "string" ? claudeMeta.toolName : undefined
          const args = { ...rawInput, kind: f.kind, ...(metaToolName && { metaToolName }) } as ReadonlyJSONObject

          if (isActiveRef.current) setIsRunning(true)
          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)

            if (!last || last.status?.type === "complete") {
              updated.push({
                id: nextId(),
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: f.toolCallId,
                    toolName: f.title ?? "unknown",
                    args,
                    argsText: typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput ?? {}),
                  },
                ],
                createdAt: new Date(),
                status: isActiveRef.current
                  ? { type: "running" }
                  : { type: "incomplete", reason: "other" },
              })
              return updated
            }

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

        case "tool_call_update": {
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
            } else if (f.status === "completed") {
              // Backend strips rawOutput for large-output tools (e.g., Bash).
              // Use ACP status to mark the tool as finished so it doesn't show
              // as failed/running during history replay.
              patch.result = ""
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

        case "plan": {
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
          if (messagesRef.current.length === 0) {
            setSessionError(f.message)
          }
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

        case "current_mode_update": {
          // ACP native frame: field is currentModeId
          const currentModeId = frame.currentModeId as string | undefined
          if (currentModeId) {
            setSessionMeta((prev) => ({ ...prev, mode: currentModeId }))
          }
          break
        }

        case "available_commands_update": {
          // ACP native frame: field is availableCommands
          const commands = frame.availableCommands as unknown[] | undefined
          if (commands) {
            setSessionMeta((prev) => ({ ...prev, commands }))
          }
          break
        }

        case "session.modeUpdate": {
          // Synthesized frame from initial session setup — uses old field names
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
          // Synthesized frame from initial session setup
          const f = frame as AcpFrame & { modelId?: string; availableModels?: unknown[] }
          const update: Partial<SessionMeta> = {}
          if (f.modelId) update.currentModel = f.modelId
          if (f.availableModels) update.availableModels = f.availableModels
          if (Object.keys(update).length > 0) {
            setSessionMeta((prev) => ({ ...prev, ...update }))
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

  // isActiveRef is populated from session.info frame sent by backend on WS connect.
  // No separate API fetch needed — the frame arrives before burst/replay.

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
            isActiveRef.current = true
          }
        }
      },
      onCancel: async () => {
        sendCancel()
      },
      // Thread list adapter — conditionally included when sessions data is provided
      ...(sessions ? {
        adapters: {
          threadList: {
            // Note: threadId, onSwitchToNewThread, onSwitchToThread are @deprecated
            // in current assistant-ui API. Pin version and watch for changes.
            threadId: activeSessionId ?? undefined,
            threads: sessions
              .filter(s => s.sessionState !== 'archived')
              .map(s => ({
                status: "regular" as const,
                id: s.id,
                title: s.summary ?? s.title,
              })),
            archivedThreads: sessions
              .filter(s => s.sessionState === 'archived')
              .map(s => ({
                status: "archived" as const,
                id: s.id,
                title: s.summary ?? s.title,
              })),
            onSwitchToNewThread: onSwitchToNewThread ?? (() => {}),
            onSwitchToThread: onSwitchToThread ?? (() => {}),
            onRename: onRenameThread,
            onArchive: onArchiveThread,
            onUnarchive: onUnarchiveThread,
            onDelete: onDeleteThread,
          },
        },
      } : {}),
    }),
    [threadMessages, isRunning, sendPrompt, sendCancel, onSend, sessions, activeSessionId, onSwitchToThread, onSwitchToNewThread, onRenameThread, onArchiveThread, onUnarchiveThread, onDeleteThread]
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
    historyLoadError,
    sessionError,
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
