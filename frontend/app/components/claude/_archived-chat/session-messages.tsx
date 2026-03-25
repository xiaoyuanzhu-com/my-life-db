import { MessageBlock } from './message-block'
import { MessageDot } from './message-dot'
import {
  isToolUseBlock,
  isToolResultBlock,
  isTaskProgressMessage,
  getParentToolUseID,
  type SessionMessage,
  type ExtractedToolResult,
  type TaskToolResult,
} from '~/lib/session-message-utils'
import { useFilteredMessages } from './use-filtered-messages'

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
export interface BashProgressMessage extends SessionMessage {
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

// HookResponseMessage and buildHookResponseMap removed — hook messages are now fully skipped
// (hooks are infrastructure plumbing; their side effects appear as system-reminders)

// Task progress message structure (periodic updates from running Task subagents)
export interface TaskProgressMessage extends SessionMessage {
  type: 'system'
  subtype: 'task_progress'
  description: string      // Current activity (e.g., "Reading ~/path/file.md")
  last_tool_name: string   // Last tool used by subagent (e.g., "Read", "Bash")
  task_id: string          // Agent task ID
  tool_use_id: string      // Links to parent Task tool_use block
  session_id: string
  usage: { duration_ms?: number; tool_uses?: number; total_tokens?: number }
}

/**
 * Build a map from tool_use_id to the latest task_progress message.
 * This allows Task tools to show live status while their subagent is running.
 *
 * NOTE: Unlike other progress maps (keyed by parentToolUseID), task_progress
 * messages link to the parent via `tool_use_id` (same linking field as task_started
 * and task_notification).
 *
 * Only the latest message per tool_use_id is kept (cumulative stats grow over time).
 */
export function buildTaskProgressMap(messages: SessionMessage[]): Map<string, TaskProgressMessage> {
  const map = new Map<string, TaskProgressMessage>()

  for (const msg of messages) {
    if (isTaskProgressMessage(msg) && msg.tool_use_id) {
      // Always overwrite — later messages have more up-to-date stats
      map.set(msg.tool_use_id, msg as TaskProgressMessage)
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
 * Result of building the async task output map.
 * Returned by buildAsyncTaskOutputMap().
 */
export interface AsyncTaskOutputMapResult {
  /** Map from original Task tool_use.id → latest TaskOutput result (merged into Task block) */
  resultMap: Map<string, TaskToolResult>
  /** Set of TaskOutput tool_use.ids that have been absorbed into a parent Task block */
  absorbedToolUseIds: Set<string>
}

/**
 * Build a map linking background async Task tool_use blocks to their TaskOutput results.
 *
 * Background Tasks (run_in_background: true) return immediately with async launch metadata
 * ({ isAsync: true, agentId: "..." }). The actual output is retrieved later via separate
 * TaskOutput tool calls. This function links them so the Task block can render the output
 * as if it were a foreground task.
 *
 * Linking chain:
 *   Task result.agentId → TaskOutput input.task_id → TaskOutput result.task.output
 *
 * @param messages - All session messages
 * @param toolResultMap - Pre-built tool result map (to look up TaskOutput results)
 * @returns resultMap (Task tool_use.id → TaskToolResult) and absorbedToolUseIds (TaskOutput IDs to skip)
 */
export function buildAsyncTaskOutputMap(
  messages: SessionMessage[],
  toolResultMap: Map<string, ExtractedToolResult>,
): AsyncTaskOutputMapResult {
  const resultMap = new Map<string, TaskToolResult>()
  const absorbedToolUseIds = new Set<string>()

  // Step 1: Find async Task launches → map agentId → Task tool_use.id
  const agentIdToTaskToolId = new Map<string, string>()

  for (const msg of messages) {
    if (msg.type !== 'user') continue
    const tur = msg.toolUseResult
    if (!tur || typeof tur !== 'object' || (tur as Record<string, unknown>).isAsync !== true) continue
    const agentId = (tur as Record<string, unknown>).agentId as string | undefined
    if (!agentId) continue

    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (isToolResultBlock(block)) {
        agentIdToTaskToolId.set(agentId, block.tool_use_id)
      }
    }
  }

  if (agentIdToTaskToolId.size === 0) return { resultMap, absorbedToolUseIds }

  // Step 2: Find TaskOutput tool_use blocks, look up their results, map back to parent Task
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!isToolUseBlock(block) || block.name !== 'TaskOutput') continue

      const taskId = (block.input as Record<string, unknown>)?.task_id as string | undefined
      if (!taskId) continue

      const taskToolId = agentIdToTaskToolId.get(taskId)
      if (!taskToolId) continue

      // This TaskOutput is for an async Task we know about — absorb it
      absorbedToolUseIds.add(block.id)

      // Look up the TaskOutput's result
      const extractedResult = toolResultMap.get(block.id)
      if (!extractedResult?.toolUseResult || typeof extractedResult.toolUseResult === 'string') continue

      const taskToolResult = extractedResult.toolUseResult as TaskToolResult

      // Prefer completed results — later TaskOutput calls override earlier ones
      const existing = resultMap.get(taskToolId)
      if (
        !existing ||
        taskToolResult.retrieval_status === 'completed' ||
        taskToolResult.task?.status === 'completed'
      ) {
        resultMap.set(taskToolId, taskToolResult)
      }
    }
  }

  return { resultMap, absorbedToolUseIds }
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

    case 'Agent':  // Claude Code renamed Task → Agent
    case 'Task':
      return truncate(input.description as string | undefined, 40) || name

    case 'TaskOutput':
      return truncate(input.task_id as string | undefined, 20) || name

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
 * Map status values to human-readable labels (base text, without trailing dots)
 */
const STATUS_LABELS: Record<string, string> = {
  compacting: 'Compacting',
}

/**
 * TransientStatusBlock - Shows ephemeral session status (e.g., "Compacting...")
 * Uses a pulsing MessageDot and progressive three-dot animation.
 * Disappears when status is cleared (null) and compact_boundary takes over.
 */
/** Exported for use by MessageList (virtual scrolling) which renders it after the virtualized list */
export function TransientStatusBlock({ status }: { status: string }) {
  const label = STATUS_LABELS[status] || status

  return (
    <div className="mb-4 flex items-start gap-2">
      <MessageDot type="compacting" />
      <span className="font-mono text-[13px] leading-[1.5] font-semibold flex items-center gap-0">
        <span style={{ color: 'var(--claude-text-primary)' }}>{label}</span>
        <span className="inline-flex w-[1.5em]">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="inline-block"
              style={{
                color: 'var(--claude-text-primary)',
                animation: `compacting-dot-${i} 1.44s linear infinite`,
              }}
            >
              .
            </span>
          ))}
        </span>
        <style>{`
          @keyframes compacting-dot-0 {
            0%, 100% { opacity: 0; }
            1%, 99% { opacity: 1; }
          }
          @keyframes compacting-dot-1 {
            0%, 33% { opacity: 0; }
            34%, 99% { opacity: 1; }
            100% { opacity: 0; }
          }
          @keyframes compacting-dot-2 {
            0%, 66% { opacity: 0; }
            67%, 99% { opacity: 1; }
            100% { opacity: 0; }
          }
        `}</style>
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
   * Nesting depth for recursive rendering.
   * 0 = top-level session, 1+ = nested agent sessions
   */
  depth?: number
}

/**
 * SessionMessages - Pure message list renderer (non-virtualized)
 *
 * This component renders a list of SessionMessages without any scroll behavior
 * or container styling. It's used for nested Task tool conversations (depth > 0).
 *
 * For top-level rendering, MessageList uses the virtualizer directly with
 * useFilteredMessages, bypassing this component.
 *
 * The depth prop allows for visual differentiation of nested sessions.
 */
export function SessionMessages({
  messages,
  toolResultMap: providedToolResultMap,
  depth = 0,
}: SessionMessagesProps) {
  const { filteredMessages, maps, currentStatus } = useFilteredMessages(
    messages,
    providedToolResultMap,
    depth,
  )

  if (filteredMessages.length === 0 && !currentStatus) {
    return null
  }

  return (
    <div className={depth > 0 ? 'nested-session' : undefined}>
      {filteredMessages.map((message) => (
        <MessageBlock
          key={message.uuid}
          message={message}
          toolResultMap={maps.toolResultMap}
          agentProgressMap={maps.agentProgressMap}
          bashProgressMap={maps.bashProgressMap}
          hookProgressMap={maps.hookProgressMap}
          toolUseMap={maps.toolUseMap}
          skillContentMap={maps.skillContentMap}
          subagentMessagesMap={maps.subagentMessagesMap}
          asyncTaskOutputMap={maps.asyncTaskOutputMap}
          taskProgressMap={maps.taskProgressMap}
          depth={depth}
        />
      ))}
      {/* Transient status indicator - shows while status is active, disappears when cleared */}
      {currentStatus && <TransientStatusBlock status={currentStatus} />}
    </div>
  )
}
