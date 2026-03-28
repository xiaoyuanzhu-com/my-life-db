/**
 * AgentContext — React context that exposes ACP-specific state and functions
 * (permissions, plan entries, connection status, sendSetMode) to deeply nested
 * components without prop drilling.
 */
import { createContext, useContext } from "react"
import type { ThreadMessageLike } from "@assistant-ui/react"
import type { PermissionOption } from "~/hooks/use-agent-websocket"
import type { PlanEntry, AvailableMode } from "~/hooks/use-agent-runtime"

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
  /** Send a setMode command to the agent */
  sendSetMode: (mode: string) => void
  /** Composer controls — working directory */
  workingDir?: string
  onWorkingDirChange?: (path: string) => void
  /** Composer controls — permission mode */
  permissionMode?: string
  availableModes?: AvailableMode[]
  onPermissionModeChange?: (mode: string) => void
  /** Composer controls — agent type */
  agentType?: string
  onAgentTypeChange?: (type: string) => void
  /** Session metadata (commands, models, etc.) */
  sessionCommands?: Array<{ name: string; description?: string }>
  /** Whether there's an active session (WS is enabled/connecting) */
  hasActiveSession?: boolean
  /** Non-null when session history failed to load (e.g., after server restart) */
  historyLoadError?: string | null
  /** Non-null when a live session failed before any message rendered */
  sessionError?: string | null
  /** Map from toolCallId to child messages for subagent tool calls */
  subagentChildrenMap?: Map<string, ThreadMessageLike[]>
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
