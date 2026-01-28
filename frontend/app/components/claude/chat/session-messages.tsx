import { useMemo } from 'react'
import { MessageBlock } from './message-block'
import {
  buildToolResultMap,
  isSkippedUserMessage,
  isHookResponseMessage,
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

// Bash progress message structure
interface BashProgressMessage extends SessionMessage {
  type: 'progress'
  parentToolUseID?: string
  data?: {
    type: 'bash_progress'
    output: string
    fullOutput: string
    elapsedTimeSeconds: number
    totalLines: number
  }
}

// Hook progress message structure
export interface HookProgressMessage extends SessionMessage {
  type: 'progress'
  parentToolUseID?: string
  toolUseID?: string
  data?: {
    type: 'hook_progress'
    hookEvent: string
    hookName: string
    command: string
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
 * Check if a message is a bash_progress message
 */
function isBashProgressMessage(msg: SessionMessage): msg is BashProgressMessage {
  return msg.type === 'progress' &&
    (msg as BashProgressMessage).data?.type === 'bash_progress'
}

/**
 * Check if a message is a hook_progress message
 */
function isHookProgressMessage(msg: SessionMessage): msg is HookProgressMessage {
  return msg.type === 'progress' &&
    (msg as HookProgressMessage).data?.type === 'hook_progress'
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

/**
 * Build a map from parentToolUseID to bash_progress messages
 * This allows Bash tools to find their associated progress updates
 */
export function buildBashProgressMap(messages: SessionMessage[]): Map<string, BashProgressMessage[]> {
  const map = new Map<string, BashProgressMessage[]>()

  for (const msg of messages) {
    if (isBashProgressMessage(msg) && msg.parentToolUseID) {
      const existing = map.get(msg.parentToolUseID) || []
      existing.push(msg)
      map.set(msg.parentToolUseID, existing)
    }
  }

  return map
}

/**
 * Build a map from parentToolUseID to hook_progress messages
 * This allows tools to find their associated hook progress updates
 * (e.g., PostToolUse hooks that run after a Read tool)
 */
export function buildHookProgressMap(messages: SessionMessage[]): Map<string, HookProgressMessage[]> {
  const map = new Map<string, HookProgressMessage[]>()

  for (const msg of messages) {
    if (isHookProgressMessage(msg) && msg.parentToolUseID) {
      const existing = map.get(msg.parentToolUseID) || []
      existing.push(msg)
      map.set(msg.parentToolUseID, existing)
    }
  }

  return map
}

// Hook response message structure (pairs with hook_started)
export interface HookResponseMessage extends SessionMessage {
  type: 'system'
  subtype: 'hook_response'
  hook_id: string
  hook_name: string
  hook_event: string
  output?: string
  stdout?: string
  stderr?: string
  exit_code?: number
  outcome?: 'success' | 'error' | string
}

/**
 * Build a map from hook_id to hook_response message
 * This allows hook_started messages to find their paired response
 */
export function buildHookResponseMap(messages: SessionMessage[]): Map<string, HookResponseMessage> {
  const map = new Map<string, HookResponseMessage>()

  for (const msg of messages) {
    if (isHookResponseMessage(msg) && msg.hook_id) {
      map.set(msg.hook_id, msg as HookResponseMessage)
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
   * Pre-built bash progress map. If not provided, will be built from messages.
   */
  bashProgressMap?: Map<string, BashProgressMessage[]>
  /**
   * Pre-built hook progress map. If not provided, will be built from messages.
   */
  hookProgressMap?: Map<string, HookProgressMessage[]>
  /**
   * Pre-built hook response map. If not provided, will be built from messages.
   */
  hookResponseMap?: Map<string, HookResponseMessage>
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
  bashProgressMap: providedBashProgressMap,
  hookProgressMap: providedHookProgressMap,
  hookResponseMap: providedHookResponseMap,
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

  // Build bash progress map if not provided
  const bashProgressMap = useMemo(() => {
    if (providedBashProgressMap) return providedBashProgressMap
    return buildBashProgressMap(messages)
  }, [messages, providedBashProgressMap])

  // Build hook progress map if not provided
  const hookProgressMap = useMemo(() => {
    if (providedHookProgressMap) return providedHookProgressMap
    return buildHookProgressMap(messages)
  }, [messages, providedHookProgressMap])

  // Build hook response map if not provided
  const hookResponseMap = useMemo(() => {
    if (providedHookResponseMap) return providedHookResponseMap
    return buildHookResponseMap(messages)
  }, [messages, providedHookResponseMap])

  // Filter out:
  // - progress messages (rendered inside their parent tools, not as standalone messages)
  // - hook_response messages (rendered inside hook_started via hookResponseMap)
  // - isMeta messages (system-injected context, not user-visible)
  // - user messages with only skipped XML tags (e.g., <command-name>/clear</command-name>)
  // - control_request/control_response (permission protocol messages, handled via modal)
  // - internal events (queue-operation, file-history-snapshot)
  const filteredMessages = useMemo(() => {
    return messages.filter((msg) => {
      // Skip all progress messages - they're rendered inside their parent tools:
      // - agent_progress → rendered inside Task tool via agentProgressMap
      // - bash_progress → rendered inside Bash tool via bashProgressMap
      // - hook_progress, query_update, search_results_received → future support
      if (msg.type === 'progress') return false

      // Skip hook_response messages - they're rendered inside hook_started via hookResponseMap
      if (isHookResponseMessage(msg)) return false

      // Skip permission protocol messages - these trigger the permission modal,
      // not standalone chat messages. See data-models.md "Permission Handling" section.
      // - control_request: Claude asks for permission to use a tool
      // - control_response: UI responds with allow/deny (sent via stdin, not displayed)
      if (msg.type === 'control_request' || msg.type === 'control_response') return false

      // Skip internal events - these are metadata messages that provide no user-facing value.
      // See data-models.md "Internal Events" section.
      // - queue-operation: Internal session queue management (enqueue/dequeue)
      // - file-history-snapshot: Internal file versioning for undo/redo
      if (msg.type === 'queue-operation' || msg.type === 'file-history-snapshot') return false

      // Skip meta messages (system-injected context)
      if (msg.isMeta) return false

      // Skip user messages with only skipped XML tags
      if (isSkippedUserMessage(msg)) return false

      return true
    })
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
          bashProgressMap={bashProgressMap}
          hookProgressMap={hookProgressMap}
          hookResponseMap={hookResponseMap}
          depth={depth}
        />
      ))}
    </div>
  )
}

export type { AgentProgressMessage, BashProgressMessage, HookResponseMessage }
