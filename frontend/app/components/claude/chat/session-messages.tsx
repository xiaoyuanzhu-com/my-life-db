import { useMemo } from 'react'
import { MessageBlock } from './message-block'
import {
  buildToolResultMap,
  isSkippedUserMessage,
  type SessionMessage,
  type ExtractedToolResult,
} from '~/lib/session-message-utils'

// Agent progress message structure
interface AgentProgressMessage extends SessionMessage {
  type: 'progress'
  parentToolUseID?: string
  data?: {
    type: 'agent_progress'
    agentId: string
    prompt: string
    normalizedMessages?: SessionMessage[]
  }
}

/**
 * Check if a message is an agent_progress message
 */
function isAgentProgressMessage(msg: SessionMessage): msg is AgentProgressMessage {
  return msg.type === 'progress' &&
    (msg as AgentProgressMessage).data?.type === 'agent_progress'
}

/**
 * Build a map from parentToolUseID to agent_progress messages
 * This allows Task tools to find their associated agent progress
 */
export function buildAgentProgressMap(messages: SessionMessage[]): Map<string, AgentProgressMessage[]> {
  const map = new Map<string, AgentProgressMessage[]>()

  for (const msg of messages) {
    if (isAgentProgressMessage(msg) && msg.parentToolUseID) {
      const existing = map.get(msg.parentToolUseID) || []
      existing.push(msg)
      map.set(msg.parentToolUseID, existing)
    }
  }

  return map
}

interface SessionMessagesProps {
  /** Messages to render */
  messages: SessionMessage[]
  /**
   * Pre-built tool result map. If not provided, will be built from messages.
   * Pass this from parent when messages come from WebSocket/state to avoid rebuilding.
   */
  toolResultMap?: Map<string, ExtractedToolResult>
  /**
   * Pre-built agent progress map. If not provided, will be built from messages.
   */
  agentProgressMap?: Map<string, AgentProgressMessage[]>
  /**
   * Nesting depth for recursive rendering.
   * 0 = top-level session, 1+ = nested agent sessions
   */
  depth?: number
}

/**
 * SessionMessages - Pure message list renderer
 *
 * This component renders a list of SessionMessages without any scroll behavior
 * or container styling. It's designed to be:
 * 1. Used by MessageList for top-level session rendering
 * 2. Used recursively by AgentProgressBlock for nested agent sessions
 *
 * The depth prop allows for visual differentiation of nested sessions
 * (e.g., indentation, border styling).
 */
export function SessionMessages({
  messages,
  toolResultMap: providedToolResultMap,
  agentProgressMap: providedAgentProgressMap,
  depth = 0,
}: SessionMessagesProps) {
  // Build tool result map if not provided (for nested sessions)
  const toolResultMap = useMemo(() => {
    if (providedToolResultMap) return providedToolResultMap
    return buildToolResultMap(messages)
  }, [messages, providedToolResultMap])

  // Build agent progress map if not provided
  const agentProgressMap = useMemo(() => {
    if (providedAgentProgressMap) return providedAgentProgressMap
    return buildAgentProgressMap(messages)
  }, [messages, providedAgentProgressMap])

  // Filter out:
  // - agent_progress messages (they're rendered inside Task tools)
  // - isMeta messages (system-injected context, not user-visible)
  // - user messages with only skipped XML tags (e.g., <command-name>/clear</command-name>)
  const filteredMessages = useMemo(() => {
    return messages.filter((msg) =>
      !isAgentProgressMessage(msg) &&
      !msg.isMeta &&
      !isSkippedUserMessage(msg)
    )
  }, [messages])

  if (filteredMessages.length === 0) {
    return null
  }

  return (
    <div className={depth > 0 ? 'nested-session' : undefined}>
      {filteredMessages.map((message) => (
        <MessageBlock
          key={message.uuid}
          message={message}
          toolResultMap={toolResultMap}
          agentProgressMap={agentProgressMap}
          depth={depth}
        />
      ))}
    </div>
  )
}

export type { AgentProgressMessage }
