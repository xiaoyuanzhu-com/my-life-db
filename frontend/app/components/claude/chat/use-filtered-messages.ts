import { useMemo } from 'react'
import {
  buildToolResultMap,
  isSkippedUserMessage,
  isHookResponseMessage,
  isHookStartedMessage,
  isStatusMessage,
  isTaskStartedMessage,
  isTaskProgressMessage,
  isSystemInitMessage,
  isSubagentMessage,
  type SessionMessage,
  type ExtractedToolResult,
  type TaskToolResult,
} from '~/lib/session-message-utils'
import {
  buildAgentProgressMap,
  buildBashProgressMap,
  buildHookProgressMap,
  buildToolUseMap,
  buildSkillContentMap,
  buildSubagentMessagesMap,
  buildAsyncTaskOutputMap,
  buildTaskProgressMap,
  type AgentProgressMessage,
  type BashProgressMessage,
  type HookProgressMessage,
  type TaskProgressMessage,
  type ToolUseInfo,
  type StatusMessage,
} from './session-messages'

/**
 * Collection of pre-built lookup maps used by MessageBlock and its children.
 * Built once from the message list and passed down to avoid redundant computation.
 */
export interface MessageMaps {
  toolResultMap: Map<string, ExtractedToolResult>
  agentProgressMap: Map<string, AgentProgressMessage[]>
  bashProgressMap: Map<string, BashProgressMessage[]>
  hookProgressMap: Map<string, HookProgressMessage[]>
  toolUseMap: Map<string, ToolUseInfo>
  skillContentMap: Map<string, string>
  subagentMessagesMap: Map<string, SessionMessage[]>
  asyncTaskOutputMap: Map<string, TaskToolResult>
  taskProgressMap: Map<string, TaskProgressMessage>
}

/**
 * useFilteredMessages — extracts filtering and map-building logic from SessionMessages.
 *
 * This hook:
 * 1. Builds all lookup maps (toolResultMap, agentProgressMap, etc.) from raw messages
 * 2. Filters out non-renderable messages (progress, hook, status, control, internal, etc.)
 * 3. Derives the current active status indicator
 *
 * Used by:
 * - MessageList (depth=0) for the virtualizer's item list
 * - SessionMessages (depth>0) for nested Task conversations
 *
 * @param messages - Raw session messages
 * @param providedToolResultMap - Pre-built tool result map (pass from parent to avoid rebuilding)
 * @param depth - Nesting depth (0 = top-level, 1+ = nested agent sessions)
 */
export function useFilteredMessages(
  messages: SessionMessage[],
  providedToolResultMap?: Map<string, ExtractedToolResult>,
  depth: number = 0,
): {
  filteredMessages: SessionMessage[]
  maps: MessageMaps
  currentStatus: string | null
} {
  // Build tool result map if not provided (for nested sessions)
  const toolResultMap = useMemo(() => {
    if (providedToolResultMap) return providedToolResultMap
    return buildToolResultMap(messages)
  }, [messages, providedToolResultMap])

  // Build agent progress map
  const agentProgressMap = useMemo(() => {
    return buildAgentProgressMap(messages)
  }, [messages])

  // Build bash progress map
  const bashProgressMap = useMemo(() => {
    return buildBashProgressMap(messages)
  }, [messages])

  // Build hook progress map
  const hookProgressMap = useMemo(() => {
    return buildHookProgressMap(messages)
  }, [messages])

  // Build tool use map
  const toolUseMap = useMemo(() => {
    return buildToolUseMap(messages)
  }, [messages])

  // Build skill content map
  const skillContentMap = useMemo(() => {
    return buildSkillContentMap(messages)
  }, [messages])

  // Build subagent messages map
  const subagentMessagesMap = useMemo(() => {
    return buildSubagentMessagesMap(messages)
  }, [messages])

  // Build async task output map
  const asyncTaskOutputMap = useMemo(() => {
    return buildAsyncTaskOutputMap(messages, toolResultMap).resultMap
  }, [messages, toolResultMap])

  // Build task progress map
  const taskProgressMap = useMemo(() => {
    return buildTaskProgressMap(messages)
  }, [messages])

  // Assemble all maps into a single object (stable reference when maps don't change)
  const maps = useMemo((): MessageMaps => ({
    toolResultMap,
    agentProgressMap,
    bashProgressMap,
    hookProgressMap,
    toolUseMap,
    skillContentMap,
    subagentMessagesMap,
    asyncTaskOutputMap,
    taskProgressMap,
  }), [
    toolResultMap,
    agentProgressMap,
    bashProgressMap,
    hookProgressMap,
    toolUseMap,
    skillContentMap,
    subagentMessagesMap,
    asyncTaskOutputMap,
    taskProgressMap,
  ])

  // Filter out non-renderable messages.
  // See session-messages.tsx for the original inline version with detailed comments.
  const filteredMessages = useMemo(() => {
    return messages.filter((msg) => {
      if (msg.type === 'progress') return false
      if (isHookStartedMessage(msg)) return false
      if (isHookResponseMessage(msg)) return false
      if (isStatusMessage(msg)) return false
      if (isTaskStartedMessage(msg)) return false
      if (isTaskProgressMessage(msg)) return false
      if (isSystemInitMessage(msg)) return false
      if (msg.type === 'control_request' || msg.type === 'control_response' || msg.type === 'control_cancel_request') return false
      if (msg.type === 'queue-operation' || msg.type === 'file-history-snapshot') return false
      if (msg.type === 'result') return false
      if (msg.type === 'stream_event') return false
      if (msg.isMeta) return false
      if (isSkippedUserMessage(msg)) return false
      if (depth === 0 && isSubagentMessage(msg)) return false
      return true
    })
  }, [messages, depth])

  // Derive current active status from the last status message
  const currentStatus = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as StatusMessage
      if (isStatusMessage(msg)) {
        return msg.status
      }
    }
    return null
  }, [messages])

  return { filteredMessages, maps, currentStatus }
}
