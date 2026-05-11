/**
 * AgentContext — React context that exposes ACP-specific state and functions
 * (permissions, plan entries, connection status, config options) to deeply nested
 * components without prop drilling.
 */
import { createContext, useContext } from "react"
import type { ThreadMessageLike } from "@assistant-ui/react"
import type { PermissionOption } from "~/hooks/use-agent-websocket"
import type { PlanEntry, ConfigOption } from "~/hooks/use-agent-runtime"
import type { UseDraftOutboxResult } from "~/lib/draft-outbox"
import type { LastTurnOutcome } from "~/types/session"

export interface PendingPermissionEntry {
  toolName: string
  options: PermissionOption[]
}

export interface AgentContextValue {
  /** Send a permission response for a pending tool call */
  sendPermissionResponse: (toolCallId: string, optionId: string) => void
  /** Pending permission requests keyed by toolCallId */
  pendingPermissions: Map<string, PendingPermissionEntry>
  /** Whether the WebSocket is connected */
  connected: boolean
  /** Plan entries from the agent runtime */
  planEntries: PlanEntry[]
  /** Composer controls — working directory */
  workingDir?: string
  onWorkingDirChange?: (path: string) => void
  /** Composer controls — agent type */
  agentType?: string
  onAgentTypeChange?: (type: string) => void
  /** Unified config options (model, mode, reasoning_effort, etc.) */
  configOptions?: ConfigOption[]
  /** Send a config option change */
  onConfigOptionChange?: (configId: string, value: string) => void
  /** Session metadata (commands, models, etc.) */
  sessionCommands?: Array<{ name: string; description?: string }>
  /** Active session ID (empty string when no session) */
  sessionId?: string
  /** Whether there's an active session (WS is enabled/connecting) */
  hasActiveSession?: boolean
  /** Non-null when session history failed to load (e.g., after server restart) */
  historyLoadError?: string | null
  /** Non-null when a live session failed before any message rendered */
  sessionError?: string | null
  /** Map from toolCallId to child messages for subagent tool calls */
  subagentChildrenMap?: Map<string, ThreadMessageLike[]>
  /**
   * Draft + outbox handle. Source of truth for composer text safety —
   * if any input is ever lost, the bug is in `~/lib/draft-outbox/`.
   * The composer reads `outbox.draft` and writes via `outbox.setDraft`.
   * The runtime calls `outbox.submit` instead of clearing localStorage by hand.
   */
  outbox?: UseDraftOutboxResult
  /** Counter that increments on each agent result, used as refreshKey for changed files */
  resultCount?: number
  /** Restart the current session (kill process + reconnect) */
  onRestart?: () => void
  /** Outcome of the last completed turn (drives the in-thread banner). */
  lastTurnOutcome?: LastTurnOutcome
  /** Unix ms timestamp when the last outcome was recorded. */
  lastTurnOutcomeAt?: number | null
  /** Populated only when lastTurnOutcome === 'errored'. */
  lastErrorMessage?: string
  /** The last prompt text that was in-flight (used for Resume). */
  lastPromptText?: string | null
  /** Source of the session: "user" or "auto" */
  sessionSource?: string | null
  /** Re-send the last prompt to resume an interrupted/cancelled/errored session */
  onResume?: () => void
  /** Clear the last-turn outcome (dismiss banner without resuming) */
  onDismissOutcome?: () => void
}

const AgentContext = createContext<AgentContextValue | null>(null)

export const AgentContextProvider = AgentContext.Provider

export function useAgentContext(): AgentContextValue {
  const ctx = useContext(AgentContext)
  if (!ctx) {
    throw new Error("useAgentContext must be used within AgentContextProvider")
  }
  return ctx
}
