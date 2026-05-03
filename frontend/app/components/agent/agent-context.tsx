/**
 * AgentContext — React context that exposes ACP-specific state and functions
 * (permissions, plan entries, connection status, config options) to deeply nested
 * components without prop drilling.
 */
import { createContext, useContext } from "react"
import type { ThreadMessageLike } from "@assistant-ui/react"
import type { PermissionOption } from "~/hooks/use-agent-websocket"
import type { PlanEntry, ConfigOption } from "~/hooks/use-agent-runtime"

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
  /** Text to restore into the composer after a failed send */
  pendingComposerText?: string | null
  /** Clear the pending composer text after it's been restored */
  clearPendingComposerText?: () => void
  /** Counter that increments on each agent result, used as refreshKey for changed files */
  resultCount?: number
  /** Restart the current session (kill process + reconnect) */
  onRestart?: () => void
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
