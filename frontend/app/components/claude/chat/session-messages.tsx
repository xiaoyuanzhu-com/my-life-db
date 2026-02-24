import { useMemo } from 'react'
import { MessageBlock } from './message-block'
import {
  buildToolResultMap,
  isSkippedUserMessage,
  isHookResponseMessage,
  isStatusMessage,
  isTaskStartedMessage,
  isSystemInitMessage,
  isToolUseBlock,
  isSubagentMessage,
  getParentToolUseID,
  type SessionMessage,
  type ExtractedToolResult,
} from '~/lib/session-message-utils'

// Tool use info for mapping tool IDs to their names and titles
export interface ToolUseInfo {
  id: string
  name: string
  title: string  // Human-readable title derived from tool parameters
}

// Agent progress message structure
export interface AgentProgressMessage extends SessionMessage {
  type: 'progress'
  parentToolUseID?: string
  data?: {
    type: 'agent_progress'
    agentId: string
    prompt: string
    normalizedMessages?: SessionMessage[]
    message?: SessionMessage  // Individual subagent message (when normalizedMessages is empty)
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

// Status message structure (ephemeral session state indicators)
export interface StatusMessage extends SessionMessage {
  type: 'system'
  subtype: 'status'
  session_id: string
  status: string | null  // e.g., "compacting" or null when cleared
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

// Skill content message structure (isMeta messages linked to Skill tool via sourceToolUseID)
export interface SkillContentMessage extends SessionMessage {
  type: 'user'
  isMeta: true
  sourceToolUseID: string
  message: {
    role: 'user'
    content: Array<{ type: 'text'; text: string }> | string
  }
}

/**
 * Check if a message is a skill content message (isMeta message linked to a Skill tool)
 */
function isSkillContentMessage(msg: SessionMessage): msg is SkillContentMessage {
  return msg.type === 'user' &&
    msg.isMeta === true &&
    typeof (msg as SkillContentMessage).sourceToolUseID === 'string'
}

/**
 * Build a map from parentToolUseID to subagent messages
 * This allows Task tools to find their subagent conversation messages
 * See docs/claude-code/data-models.md "Subagent Message Hierarchy" section
 */
export function buildSubagentMessagesMap(messages: SessionMessage[]): Map<string, SessionMessage[]> {
  const map = new Map<string, SessionMessage[]>()

  for (const msg of messages) {
    const parentId = getParentToolUseID(msg)
    if (parentId) {
      const existing = map.get(parentId) || []
      existing.push(msg)
      map.set(parentId, existing)
    }
  }

  return map
}

/**
 * Build a map from sourceToolUseID to skill content
 * This allows Skill tools to find their associated skill prompt content
 */
export function buildSkillContentMap(messages: SessionMessage[]): Map<string, string> {
  const map = new Map<string, string>()

  for (const msg of messages) {
    if (isSkillContentMessage(msg) && msg.sourceToolUseID) {
      // Extract text content from the message
      const content = msg.message?.content
      let text = ''
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        text = content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map(block => block.text)
          .join('\n')
      }
      if (text) {
        map.set(msg.sourceToolUseID, text)
      }
    }
  }

  return map
}

/**
 * Extract a human-readable title from tool parameters
 */
function getToolTitle(name: string, input: Record<string, unknown>): string {
  // Extract primary parameter based on tool type
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return extractFilename(input.file_path as string | undefined) || name

    case 'Bash':
      return truncate(input.command as string | undefined, 40) || name

    case 'Grep':
      return truncate(input.pattern as string | undefined, 30) || name

    case 'Glob':
      return truncate(input.pattern as string | undefined, 30) || name

    case 'WebFetch':
      return truncate(input.url as string | undefined, 40) || name

    case 'WebSearch':
      return truncate(input.query as string | undefined, 40) || name

    case 'Task':
      return truncate(input.description as string | undefined, 40) || name

    case 'TodoWrite':
      return 'update todos'

    default:
      return name
  }
}

/** Extract filename from a path */
function extractFilename(path: string | undefined): string | undefined {
  if (!path) return undefined
  const parts = path.split('/')
  return parts[parts.length - 1]
}

/** Truncate string to max length */
function truncate(str: string | undefined, maxLen: number): string | undefined {
  if (!str) return undefined
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

/**
 * Build a map from tool_use ID to tool info (name + title)
 * This allows microcompact_boundary messages to show which tools were compacted
 */
export function buildToolUseMap(messages: SessionMessage[]): Map<string, ToolUseInfo> {
  const map = new Map<string, ToolUseInfo>()

  for (const msg of messages) {
    // Tool uses are in assistant messages
    if (msg.type !== 'assistant') continue

    const content = msg.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (isToolUseBlock(block)) {
        map.set(block.id, {
          id: block.id,
          name: block.name,
          title: getToolTitle(block.name, block.input),
        })
      }
    }
  }

  return map
}

/**
 * Map status values to human-readable labels
 */
const STATUS_LABELS: Record<string, string> = {
  compacting: 'Compacting...',
}

/**
 * TransientStatusBlock - Shows ephemeral session status (e.g., "Compacting...")
 * Disappears when status is cleared (null) and compact_boundary takes over
 */
function TransientStatusBlock({ status }: { status: string }) {
  const label = STATUS_LABELS[status] || `${status}...`

  return (
    <div className="mb-4 flex items-start gap-2">
      {/* Orange dot indicates running/in-progress state */}
      <span
        className="select-none font-mono text-[13px] leading-[1.5]"
        style={{ color: 'var(--claude-status-warn, #F59E0B)' }}
      >
        ●
      </span>
      <span
        className="font-mono text-[13px] leading-[1.5]"
        style={{ color: 'var(--claude-text-secondary)' }}
      >
        {label}
      </span>
    </div>
  )
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
   * Pre-built tool use map. If not provided, will be built from messages.
   */
  toolUseMap?: Map<string, ToolUseInfo>
  /**
   * Pre-built skill content map. If not provided, will be built from messages.
   * Maps sourceToolUseID to skill prompt content (from isMeta messages).
   */
  skillContentMap?: Map<string, string>
  /**
   * Pre-built subagent messages map. If not provided, will be built from messages.
   * Maps parentToolUseID to subagent conversation messages (for Task tools).
   */
  subagentMessagesMap?: Map<string, SessionMessage[]>
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
  toolUseMap: providedToolUseMap,
  skillContentMap: providedSkillContentMap,
  subagentMessagesMap: providedSubagentMessagesMap,
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

  // Build tool use map if not provided
  const toolUseMap = useMemo(() => {
    if (providedToolUseMap) return providedToolUseMap
    return buildToolUseMap(messages)
  }, [messages, providedToolUseMap])

  // Build skill content map if not provided
  const skillContentMap = useMemo(() => {
    if (providedSkillContentMap) return providedSkillContentMap
    return buildSkillContentMap(messages)
  }, [messages, providedSkillContentMap])

  // Build subagent messages map if not provided
  const subagentMessagesMap = useMemo(() => {
    if (providedSubagentMessagesMap) return providedSubagentMessagesMap
    return buildSubagentMessagesMap(messages)
  }, [messages, providedSubagentMessagesMap])

  // Filter out:
  // - progress messages (rendered inside their parent tools, not as standalone messages)
  // - hook_response messages (rendered inside hook_started via hookResponseMap)
  // - isMeta messages (system-injected context, not user-visible)
  // - user messages with only skipped XML tags (e.g., <command-name>/clear</command-name>)
  // - control_request/control_response (permission protocol messages, handled via modal)
  // - internal events (queue-operation, file-history-snapshot)
  // - stream_event messages (streaming transport signals, no user-facing content)
  // - subagent messages (rendered inside their parent Task tool via subagentMessagesMap)
  const filteredMessages = useMemo(() => {
    return messages.filter((msg) => {
      // Skip all progress messages - they're rendered inside their parent tools:
      // - agent_progress → rendered inside Task tool via agentProgressMap
      // - bash_progress → rendered inside Bash tool via bashProgressMap
      // - hook_progress, query_update, search_results_received → future support
      if (msg.type === 'progress') return false

      // Skip hook_response messages - they're rendered inside hook_started via hookResponseMap
      if (isHookResponseMessage(msg)) return false

      // Skip status messages - rendered as transient indicator at the end of the message list
      // when status is non-null (e.g., "compacting"), disappears when status becomes null
      if (isStatusMessage(msg)) return false

      // Skip task_started messages - these are redundant with the Task tool_use block that
      // already shows the same description. The task_started message has no linking field
      // (task_id ≠ tool_use.id) so it can't be merged into the tool block either.
      if (isTaskStartedMessage(msg)) return false

      // Skip system init messages - these are session-level metadata (model, tools, agents, etc.)
      // not user-facing content. The metadata is extracted in chat-interface.tsx and exposed
      // via initData for use by slash commands, session info display, etc.
      if (isSystemInitMessage(msg)) return false

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

      // Skip result messages - these are turn terminators sent via stdout (not persisted to JSONL).
      // They signal the end of Claude's turn and contain summary statistics (duration, cost, tokens).
      // Used by isWorking detection (last message type !== 'result'), but not displayed as chat messages.
      // See data-models.md "The result Message (Session Terminator)" section.
      if (msg.type === 'result') return false

      // Skip stream_event messages - these are streaming transport signals from the Claude API
      // (e.g., message_start, content_block_delta, message_stop). They appear when sessions are
      // streamed with --include-partial-messages. They carry no user-facing content, only event
      // lifecycle metadata used by the SDK's streaming protocol.
      if (msg.type === 'stream_event') return false

      // rate_limit_event is now rendered as a message block — do not skip it here.

      // Skip meta messages (system-injected context)
      if (msg.isMeta) return false

      // Skip user messages with only skipped XML tags
      if (isSkippedUserMessage(msg)) return false

      // Skip subagent messages at top level - they're rendered inside their parent Task tool via subagentMessagesMap
      // See data-models.md "Subagent Message Hierarchy" section.
      // When depth > 0, we're already inside a Task tool's nested session, so don't filter these out.
      if (depth === 0 && isSubagentMessage(msg)) return false

      return true
    })
  }, [messages, depth])

  // Derive current active status from the last status message
  // Status messages are ephemeral indicators (e.g., "compacting") that should show
  // while active, then disappear when cleared (status: null)
  const currentStatus = useMemo(() => {
    // Find the last status message (iterate in reverse)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as StatusMessage
      if (isStatusMessage(msg)) {
        // Return the status value (could be "compacting", null, etc.)
        return msg.status
      }
    }
    return null
  }, [messages])

  if (filteredMessages.length === 0 && !currentStatus) {
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
          toolUseMap={toolUseMap}
          skillContentMap={skillContentMap}
          subagentMessagesMap={subagentMessagesMap}
          depth={depth}
        />
      ))}
      {/* Transient status indicator - shows while status is active, disappears when cleared */}
      {currentStatus && <TransientStatusBlock status={currentStatus} />}
    </div>
  )
}

export type { BashProgressMessage }
