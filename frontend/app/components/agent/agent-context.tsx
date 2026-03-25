/**
 * AgentContext — React context that exposes ACP-specific state and functions
 * (permissions, plan entries, connection status, sendSetMode) to deeply nested
 * components without prop drilling.
 */
import { createContext, useContext } from "react"
import type { PermissionOption } from "~/hooks/use-agent-websocket"
import type { PlanEntry } from "~/hooks/use-agent-runtime"

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
