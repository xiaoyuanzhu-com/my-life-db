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
  parentToolUseId?: string
  planEntries?: PlanEntry[]
}

export interface AvailableMode {
  id: string
  name: string
  description: string
}

export interface SessionMeta {
  mode?: string
  availableModes?: AvailableMode[]
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

/** Extract parentToolUseId from ACP frame _meta */
function getFrameParentToolUseId(frame: AcpFrame): string | undefined {
  const meta = frame._meta as Record<string, unknown> | undefined
  const acpMeta = meta?.claudeCode as Record<string, unknown> | undefined // protocol field name
  return typeof acpMeta?.parentToolUseId === "string"
    ? acpMeta.parentToolUseId
    : undefined
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

  // ── Diagnostics ─────────────────────────────────────────────────────
  // Tagged console logger for post-mortem debugging when send-after-error
  // fails. Use sessionId prefix so logs can be filtered in the console.
  const diagLog = useCallback(
    (event: string, data?: Record<string, unknown>) => {
      console.info(
        `[agent-diag] [${sessionId || "new"}] ${event}`,
        data ?? "",
      )
    },
    [sessionId],
  )
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

  // Optimistic message text that should survive the session ID reset
  // when transitioning from "no session" → "new session created"
  const pendingOptimisticRef = useRef<string | null>(null)

  // Text to restore into the composer after a failed send
  const [pendingComposerText, setPendingComposerText] = useState<string | null>(null)


  // Generate globally unique message IDs to avoid collisions in
  // assistant-ui's MessageRepository when switching sessions.
  const nextId = useCallback(() => crypto.randomUUID(), [])

  // Reset all per-session state when switching sessions
  const prevSessionIdRef = useRef(sessionId)
  if (prevSessionIdRef.current !== sessionId) {
    prevSessionIdRef.current = sessionId
    // If we have a pending optimistic message (new session just created),
    // preserve it so the user sees their message + working indicator
    // while the WS connects and frames arrive.
    const pendingText = pendingOptimisticRef.current
    if (pendingText) {
      pendingOptimisticRef.current = null
      setMessages([{
        id: nextId(),
        role: "user",
        content: [{ type: "text", text: pendingText }],
        createdAt: new Date(),
        isOptimistic: true,
      }])
      setIsRunning(true)
    } else {
      setMessages([])
      setIsRunning(false)
    }
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

  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const isRunningRef = useRef(isRunning)
  isRunningRef.current = isRunning

  // ── Frame Handler ─────────────────────────────────────────────────

  const onFrame = useCallback(
    (frame: AcpFrame) => {
      // Route by discriminator: ACP native frames use sessionUpdate,
      // synthesized frames use type
      const frameType = frame.sessionUpdate || frame.type

      switch (frameType) {
        case "session.info": {
          const f = frame as SessionInfoFrame
          diagLog("session.info", { isActive: f.isActive, isProcessing: f.isProcessing })
          isActiveRef.current = f.isActive
          // The backend replays full history on every WS connection (including
          // reconnects).  Clear existing messages so the replay doesn't create
          // duplicates.  Preserve any optimistic messages — they haven't been
          // confirmed by the server yet and will be reconciled when the
          // matching user_message_chunk arrives in the replay.
          setMessages((prev) => prev.filter((m) => m.isOptimistic))
          setIsRunning(f.isProcessing)
          setPendingPermissions(new Map())
          setHistoryLoadError(null)
          setSessionError(null)
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

          // Check if this reconciles an optimistic message — if so, the
          // message was confirmed sent and we can clear the persisted draft.
          {
            const hasOptimistic = messagesRef.current.some(
              (m) =>
                m.role === "user" &&
                m.isOptimistic &&
                m.content.some((p) => p.type === "text" && p.text === text)
            )
            if (hasOptimistic) {
              localStorage.removeItem(`agent-input:${sessionId}`)
              localStorage.removeItem("agent-input:new-session")
            }
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

            // Close all root-scope assistant messages when a new user message arrives.
            // During replay this is the only turn boundary signal (no turn.complete).
            // During live sessions this handles interruptions — the CLI doesn't emit
            // turn.complete or tool_call_update for cancelled turns, so pending tool
            // calls would stay as spinners forever without this.
            // Must iterate all (not just findLastAssistant) because plan messages
            // split a turn into multiple assistant messages.
            for (let i = updated.length - 1; i >= 0; i--) {
              const msg = updated[i]
              if (msg.role === "user") break
              if (
                msg.role === "assistant" &&
                !msg.parentToolUseId &&
                msg.status?.type !== "complete"
              ) {
                updated[i] = {
                  ...msg,
                  status: { type: "incomplete", reason: "cancelled" },
                }
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
          const parentToolUseId = getFrameParentToolUseId(frame)


          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated, parentToolUseId)

            // If no open assistant message exists, create one.
            //
            // Message status: use isRunningRef (not isActiveRef).
            // assistant-ui derives thread.isRunning from the last message's
            // status (lastMessage.status.type === "running"), NOT from the
            // adapter's isRunning prop. Using isActiveRef ("has a prompt been
            // sent") would mark ALL replay messages as "running" for any
            // session that was ever used, causing the WIP indicator to appear.
            //
            // Scenarios covered:
            // - Completed session reopened: isRunning=false → "incomplete" → no WIP ✓
            // - Live turn in progress: isRunning=true → "running" → WIP shows ✓
            // - Server restart mid-turn: isProcessing=false (fresh state),
            //   ACP history replay has no turn markers → "incomplete" → idle ✓
            // - Old sessions without turn.start/turn.complete in rawMessages:
            //   isRunning stays false from session.info → "incomplete" ✓
            // Also create a new message if a user message is the most recent entry —
            // a user message always marks a turn boundary, so never append across it.
            // For scoped (subagent) frames, check the last message within that scope.
            const lastInScope = parentToolUseId
              ? [...updated].reverse().find(m => m.parentToolUseId === parentToolUseId)
              : updated[updated.length - 1]
            const lastIsUser = lastInScope?.role === "user"
            if (!last || last.status?.type === "complete" || lastIsUser) {
              // Don't create a new assistant message from an empty text chunk
              if (!chunk) return prev
              updated.push({
                id: nextId(),
                role: "assistant",
                content: [{ type: "text", text: chunk }],
                createdAt: new Date(),
                status: isRunningRef.current
                  ? { type: "running" }
                  : { type: "incomplete", reason: "other" },
                parentToolUseId,
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

            replaceLastAssistant(updated, { ...last, content: parts }, parentToolUseId)
            return updated
          })
          break
        }

        case "agent_thought_chunk": {
          setSessionError(null)
          const f = frame as AgentThoughtChunkFrame
          if (f.content?.type !== "text") break
          const chunk = f.content.text
          const parentToolUseId = getFrameParentToolUseId(frame)


          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated, parentToolUseId)

            const lastInScope = parentToolUseId
              ? [...updated].reverse().find(m => m.parentToolUseId === parentToolUseId)
              : updated[updated.length - 1]
            const lastIsUser = lastInScope?.role === "user"
            if (!last || last.status?.type === "complete" || lastIsUser) {
              // Don't create a new assistant message from an empty thought chunk
              if (!chunk) return prev
              updated.push({
                id: nextId(),
                role: "assistant",
                content: [{ type: "reasoning", text: chunk }],
                createdAt: new Date(),
                status: isRunningRef.current
                  ? { type: "running" }
                  : { type: "incomplete", reason: "other" },
                parentToolUseId,
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

            replaceLastAssistant(updated, { ...last, content: parts }, parentToolUseId)
            return updated
          })
          break
        }

        case "tool_call": {
          setSessionError(null)
          const f = frame as AgentToolCallFrame
          const rawInput = (f.rawInput ?? {}) as Record<string, unknown>
          // Include kind from the frame so tool renderers can dispatch on it.
          // Extract _meta toolName for display label (e.g., "Bash").
          const meta = f._meta as Record<string, unknown> | undefined
          const acpMeta = meta?.claudeCode as Record<string, unknown> | undefined // protocol field
          const metaToolName = typeof acpMeta?.toolName === "string" ? acpMeta.toolName : undefined
          const parentToolUseId = typeof acpMeta?.parentToolUseId === "string" ? acpMeta.parentToolUseId : undefined
          const args = { ...rawInput, kind: f.kind, ...(metaToolName && { metaToolName }) } as ReadonlyJSONObject


          setMessages((prev) => {
            const updated = [...prev]

            const last = findLastAssistant(updated, parentToolUseId)

            const lastInScope = parentToolUseId
              ? [...updated].reverse().find(m => m.parentToolUseId === parentToolUseId)
              : updated[updated.length - 1]
            const lastIsUser = lastInScope?.role === "user"
            if (!last || last.status?.type === "complete" || lastIsUser) {
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
                status: isRunningRef.current
                  ? { type: "running" }
                  : { type: "incomplete", reason: "other" },
                parentToolUseId,
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

            replaceLastAssistant(updated, { ...last, content: parts }, parentToolUseId)
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

            // Build the patch from the frame data
            const patch: Partial<ToolCallPart> = {}

            if ("rawOutput" in f) {
              patch.result = f.rawOutput
            } else {
              // Check _meta toolResponse for tool results delivered
              // via metadata (some tools send results there instead of rawOutput)
              const meta = f._meta as Record<string, unknown> | undefined
              const acpMeta = meta?.claudeCode as Record<string, unknown> | undefined // protocol field
              if (acpMeta?.toolResponse != null) {
                patch.result = acpMeta.toolResponse
              } else if (f.status === "completed") {
                // Backend strips rawOutput for large-output tools (e.g., Bash).
                // Use ACP status to mark the tool as finished so it doesn't show
                // as failed/running during history replay.
                // assistant-ui uses `!part.result` (truthiness) to check if pending,
                // so result must be truthy — empty string doesn't work.
                patch.result = undefined // placeholder, set per-match below
              }
            }
            if ("title" in f && typeof f.title === "string") {
              patch.toolName = f.title
            }
            // Patch args when rawInput arrives in update (e.g., Skill tool sends
            // skill name in tool_call_update, not the initial tool_call frame)
            if ("rawInput" in f && f.rawInput != null) {
              const rawInput = f.rawInput as Record<string, unknown>
              const meta = f._meta as Record<string, unknown> | undefined
              const claudeMeta = meta?.claudeCode as Record<string, unknown> | undefined
              const metaToolName = typeof claudeMeta?.toolName === "string" ? claudeMeta.toolName : undefined
              patch.args = { ...rawInput, ...(metaToolName && { metaToolName }) } as ReadonlyJSONObject
              patch.argsText = JSON.stringify(rawInput)
            }

            // Reverse-scan ALL assistant messages to find the tool call.
            // For subagent tool calls, the tool call may be in a different
            // assistant message than the last one.
            for (let i = updated.length - 1; i >= 0; i--) {
              const msg = updated[i]
              if (msg.role !== "assistant") continue
              const parts = [...msg.content]
              const idx = parts.findIndex(
                (p) => p.type === "tool-call" && p.toolCallId === toolCallId
              )
              if (idx === -1) continue

              // Found it — apply patch and return
              const existing = parts[idx] as ToolCallPart
              // Handle the "completed but no rawOutput" case with existing result
              if (!("rawOutput" in f) && f.status === "completed" && patch.result === undefined) {
                patch.result = existing.result || " "
              }
              // Preserve kind and metaToolName from initial tool_call when
              // tool_call_update replaces args (rawInput patching drops them)
              if (patch.args && existing.args) {
                const ea = existing.args as Record<string, unknown>
                const pa = patch.args as Record<string, unknown>
                if (ea.kind && !pa.kind) pa.kind = ea.kind
                if (ea.metaToolName && !pa.metaToolName) pa.metaToolName = ea.metaToolName
              }
              parts[idx] = { ...existing, ...patch }
              updated[i] = { ...msg, content: parts }
              return updated
            }

            return prev
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

          // Update status on existing tool-call part if it exists.
          // Don't create new tool-call parts here — the tool_call frame
          // handles that with proper kind/metaToolName/parentToolUseId.
          // During replay, permission.request may arrive before tool_call;
          // the tool_call handler will create the part in the correct scope.
          setMessages((prev) => {
            const updated = [...prev]
            // Scan all assistant messages for the tool call part
            for (let i = updated.length - 1; i >= 0; i--) {
              const msg = updated[i]
              if (msg.role !== "assistant") continue
              const parts = [...msg.content]
              const idx = parts.findIndex(
                (p) => p.type === "tool-call" && p.toolCallId === toolCallId
              )
              if (idx === -1) continue

              // Found — just update status
              updated[i] = {
                ...msg,
                content: parts,
                status: { type: "requires-action", reason: "tool-calls" },
              }
              return updated
            }
            return prev
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
            // Inject as a synthetic message block in the thread where it appears.
            setMessages((prev) => [
              ...prev,
              {
                id: nextId(),
                role: "assistant",
                content: [],
                createdAt: new Date(),
                status: { type: "complete", reason: "stop" },
                planEntries: parsed,
              },
            ])
          }
          break
        }

        case "turn.start": {
          // Backend signals that prompt processing has begun. Sets isRunning
          // so the stop button is available even before content frames arrive.
          // Also present in burst replay on reconnect.
          diagLog("turn.start", { isActive: isActiveRef.current, wasRunning: isRunningRef.current })

          if (isActiveRef.current) {
            setIsRunning(true)
          }
          break
        }

        case "session.cancelled": {
          // Server ack for session.cancel — immediately stop spinner and clear permissions.
          // turn.complete from ACP will arrive later and is idempotent.
          setIsRunning(false)
          setPendingPermissions((prev) => {
            if (prev.size === 0) return prev
            return new Map()
          })
          setMessages((prev) => {
            const updated = [...prev]
            const last = findLastAssistant(updated)
            if (!last) return prev
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

        case "turn.complete": {
          diagLog("turn.complete", { wasRunning: isRunningRef.current, msgCount: messagesRef.current.length })
          setIsRunning(false)
          // Clear all pending permissions — the turn is done
          setPendingPermissions((prev) => {
            if (prev.size === 0) return prev
            return new Map()
          })
          // Note: turn.complete/error only close the root-scope assistant message.
          // Subagent-scoped messages may retain stale status, but SubagentSession
          // derives status from toolPart.result rather than message.status, so this
          // is safe. If future code inspects message.status for subagent messages,
          // this will need to iterate all scopes.
          setMessages((prev) => {
            const updated = [...prev]
            // Close ALL root-scope assistant messages, not just the last one.
            // Plan messages (TodoWrite) act as visual breaks that split a single
            // turn into multiple assistant messages. Without this, earlier
            // assistant messages before a plan keep status "running" forever.
            let changed = false
            for (let i = updated.length - 1; i >= 0; i--) {
              const msg = updated[i]
              if (msg.role === "user") break // stop at turn boundary
              if (
                msg.role === "assistant" &&
                !msg.parentToolUseId &&
                msg.status?.type !== "complete"
              ) {
                const content = msg.content.map((part) => {
                  if (part.type === "tool-call" && part.result === undefined) {
                    return { ...part, result: "" }
                  }
                  return part
                })
                updated[i] = {
                  ...msg,
                  content,
                  status: { type: "complete", reason: "stop" },
                }
                changed = true
              }
            }
            return changed ? updated : prev
          })
          break
        }

        case "error": {
          const f = frame as ErrorFrame
          const lastMsg = messagesRef.current[messagesRef.current.length - 1]
          diagLog("error", {
            code: f.code,
            message: f.message,
            wasRunning: isRunningRef.current,
            msgCount: messagesRef.current.length,
            lastMsgRole: lastMsg?.role,
            lastMsgStatus: lastMsg?.status?.type,
          })
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
            // Close all root-scope assistant messages (same rationale as turn.complete)
            let changed = false
            for (let i = updated.length - 1; i >= 0; i--) {
              const msg = updated[i]
              if (msg.role === "user") break
              if (
                msg.role === "assistant" &&
                !msg.parentToolUseId &&
                msg.status?.type !== "complete"
              ) {
                const content = msg.content.map((part) => {
                  if (part.type === "tool-call" && part.result === undefined) {
                    return { ...part, result: "", isError: true }
                  }
                  return part
                })
                updated[i] = {
                  ...msg,
                  content,
                  status: {
                    type: "incomplete",
                    reason: "error",
                    error: f.message,
                  },
                }
                changed = true
              }
            }
            return changed ? updated : prev
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

        case "config_option_update": {
          // ACP native frame: unified config options (mode, model, etc.)
          const configOptions = frame.configOptions as Array<{
            id: string; category: string; currentValue: string;
            options: Array<{ value: string; name: string; description: string }>
          }> | undefined
          if (configOptions) {
            const update: Partial<SessionMeta> = {}
            for (const opt of configOptions) {
              if (opt.category === "mode") {
                update.mode = opt.currentValue
                update.availableModes = opt.options.map(o => ({
                  id: o.value, name: o.name, description: o.description,
                }))
              } else if (opt.category === "model") {
                update.currentModel = opt.currentValue
                update.availableModels = opt.options.map(o => ({
                  id: o.value, name: o.name, description: o.description,
                }))
              }
            }
            if (Object.keys(update).length > 0) {
              setSessionMeta((prev) => ({ ...prev, ...update }))
            }
          }
          break
        }

        case "session.modeUpdate": {
          // Legacy synthesized frame — kept for backward compatibility
          const f = frame as AcpFrame & { modeId?: string; availableModes?: AvailableMode[] }
          const update: Partial<SessionMeta> = {}
          if (f.modeId) update.mode = f.modeId
          if (f.availableModes) update.availableModes = f.availableModes
          if (Object.keys(update).length > 0) {
            setSessionMeta((prev) => ({ ...prev, ...update }))
          }
          break
        }

        case "session.modelsUpdate": {
          // Legacy synthesized frame — kept for backward compatibility
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

  const { connected, sendPrompt, sendCancel, sendKill, sendPermissionResponse, sendSetMode } =
    useAgentWebSocket({
      sessionId,
      token,
      onFrame,
      enabled,
    })

  // isActiveRef is populated from session.info frame sent by backend on WS connect.
  // No separate API fetch needed — the frame arrives before burst/replay.

  // ── Build ThreadMessageLike Array ─────────────────────────────────

  const convertMessage = useCallback(
    (msg: InternalMessage): ThreadMessageLike => ({
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
      metadata: {
        custom: {
          ...(msg.isOptimistic && { isOptimistic: true }),
          ...(msg.parentToolUseId && { parentToolUseId: msg.parentToolUseId }),
          ...(msg.planEntries && { planEntries: msg.planEntries }),
        },
      },
    }),
    []
  )

  const { rootMessages, subagentChildrenMap } = useMemo(() => {
    const root: ThreadMessageLike[] = []
    const children = new Map<string, ThreadMessageLike[]>()

    for (const msg of messages) {
      const tmsg = convertMessage(msg)
      if (msg.parentToolUseId) {
        const list = children.get(msg.parentToolUseId) ?? []
        list.push(tmsg)
        children.set(msg.parentToolUseId, list)
      } else {
        root.push(tmsg)
      }
    }

    return { rootMessages: root, subagentChildrenMap: children }
  }, [messages, convertMessage])

  // ── ExternalStoreAdapter ──────────────────────────────────────────

  const adapter: ExternalStoreAdapter<ThreadMessageLike> = useMemo(
    () => ({
      messages: rootMessages,
      isRunning,
      onNew: async (message) => {
        // Extract text from the AppendMessage content parts
        const textParts = message.content.filter(
          (p): p is { type: "text"; text: string } => p.type === "text"
        )
        const text = textParts.map((p) => p.text).join("\n")
        if (text.trim()) {
          if (onSend) {
            // Persist to localStorage so the text survives failures / page refresh.
            localStorage.setItem("agent-input:new-session", text)
            // Show optimistic user message + working indicator immediately,
            // then route to parent handler to create the session via API.
            // The text is stashed in pendingOptimisticRef so the session ID
            // reset (when the new session is created) preserves it.
            pendingOptimisticRef.current = text
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
            setIsRunning(true)
            // Clear draft now — failure recovery uses pendingComposerText,
            // not localStorage. Without this the DraftPersistenceSync restore
            // effect can race (composerRuntime ref changes when the adapter
            // rebuilds) and put the just-sent text back into the composer.
            localStorage.removeItem("agent-input:new-session")
            // Fire and handle failure — if session creation fails, restore
            // the text back into the composer so the user doesn't lose it.
            Promise.resolve(onSend(text)).catch(() => {
              pendingOptimisticRef.current = null
              setMessages([])
              setIsRunning(false)
              setPendingComposerText(text)
            })
          } else {
            // Persist to localStorage before sending
            localStorage.setItem(`agent-input:${sessionId}`, text)
            // Try to send via WS — if not connected, restore to composer
            const sent = sendPrompt(text)
            diagLog("onNew:send", {
              sent,
              wasRunning: isRunningRef.current,
              msgCount: messagesRef.current.length,
              lastMsgRole: messagesRef.current[messagesRef.current.length - 1]?.role,
              lastMsgStatus: messagesRef.current[messagesRef.current.length - 1]?.status?.type,
            })
            if (!sent) {
              diagLog("onNew:send-failed", { reason: "WS not connected" })
              setPendingComposerText(text)
              return
            }
            // Clear draft now — ws.send() accepted the bytes, and failure
            // recovery uses pendingComposerText, not localStorage.
            localStorage.removeItem(`agent-input:${sessionId}`)
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
            setIsRunning(true)
            isActiveRef.current = true
          }
        }
      },
      onCancel: async () => {
        sendCancel()
        // If still running after 3s, force-kill the session
        setTimeout(() => {
          if (isRunningRef.current) {
            sendKill()
          }
        }, 3000)
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
    [rootMessages, isRunning, sendPrompt, sendCancel, sendKill, onSend, sessions, activeSessionId, onSwitchToThread, onSwitchToNewThread, onRenameThread, onArchiveThread, onUnarchiveThread, onDeleteThread]
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

  const clearPendingComposerText = useCallback(() => {
    setPendingComposerText(null)
  }, [])

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
    subagentChildrenMap,
    pendingComposerText,
    clearPendingComposerText,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function findLastAssistant(
  messages: InternalMessage[],
  parentToolUseId?: string
): InternalMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    // Root-level plan messages act as a visual break — stop searching so
    // subsequent content creates a new assistant message after the plan.
    if (!parentToolUseId && messages[i].planEntries) return undefined
    if (
      messages[i].role === "assistant" &&
      messages[i].parentToolUseId === parentToolUseId
    ) {
      return messages[i]
    }
  }
  return undefined
}

function replaceLastAssistant(
  messages: InternalMessage[],
  replacement: InternalMessage,
  parentToolUseId?: string
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    // Stop at plan messages to match findLastAssistant behavior
    if (!parentToolUseId && messages[i].planEntries) return
    if (
      messages[i].role === "assistant" &&
      messages[i].parentToolUseId === parentToolUseId
    ) {
      messages[i] = replacement
      return
    }
  }
}
