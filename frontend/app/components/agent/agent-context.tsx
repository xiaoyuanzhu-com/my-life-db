/**
 * AgentContext — React context that exposes ACP-specific functions
 * (sendPermissionResponse, sendSetMode) to deeply nested components
 * without prop drilling.
 */
import { createContext, useContext } from "react"
import type { PermissionOption } from "~/hooks/use-agent-websocket"

export interface PendingPermissionEntry {
  toolName: string
  options: PermissionOption[]
}

export interface AgentContextValue {
  /** Send a permission response for a pending tool call */
  sendPermissionResponse: (toolCallId: string, optionId: string) => void
  /** Pending permission requests keyed by toolCallId */
  pendingPermissions: Map<string, PendingPermissionEntry>
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
