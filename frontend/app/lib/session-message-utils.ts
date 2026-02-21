// Session message types and utilities for Claude Code
// These types mirror the backend models for parsing WebSocket messages

// Content block types from Claude API
export interface TextContentBlock {
  type: 'text'
  text: string
}

export interface ThinkingContentBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface ToolUseContentBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultContentBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: string; [key: string]: unknown }>
  is_error?: boolean
}

export type ContentBlock = TextContentBlock | ThinkingContentBlock | ToolUseContentBlock | ToolResultContentBlock | { type: string; [key: string]: unknown }

// Token usage statistics
export interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
  service_tier?: string
}

// Message structure in JSONL files
export interface ClaudeMessage {
  role: 'user' | 'assistant'
  // User messages: string content
  // Assistant messages: array of content blocks
  content: string | ContentBlock[]
  model?: string
  id?: string
  type?: string // "message" for assistant responses
  stop_reason?: string | null
  stop_sequence?: string | null
  usage?: TokenUsage
}

// Session message from Claude Code JSONL files
export interface SessionMessage {
  type: 'user' | 'assistant' | 'tool_result' | 'queue-operation' | 'summary' | string
  uuid: string
  parentUuid?: string | null
  timestamp: string
  message?: ClaudeMessage | null

  // Additional fields
  isSidechain?: boolean
  isMeta?: boolean  // Meta messages (system-injected context) - should not be rendered
  isCompactSummary?: boolean  // True for compact summary user messages
  isVisibleInTranscriptOnly?: boolean
  userType?: string
  cwd?: string
  sessionId?: string
  version?: string
  gitBranch?: string
  requestId?: string
  sourceToolAssistantUUID?: string // For tool results: UUID of the assistant message that initiated the tool call

  // Tool use result - varies by tool type (see docs/claude-code/data-models.md)
  // Can be string (for errors) or object (for success with tool-specific fields)
  // NOTE: After normalization, this is always camelCase. See normalizeMessage().
  toolUseResult?: ToolUseResult
  tool_use_result?: ToolUseResult  // Pre-normalization only (from stdout)

  // System message fields (when type === 'system')
  // IMPORTANT: System messages do NOT have a `message` field - their data is on the root object
  // See docs/claude-code/data-models.md "System Messages" section
  subtype?: SystemSubtype
  content?: string  // Human-readable message for system events
  level?: 'info' | 'error'
  logicalParentUuid?: string  // For compact_boundary: logical parent (different from parentUuid)
  compactMetadata?: CompactMetadata
  microcompactMetadata?: MicrocompactMetadata  // For microcompact_boundary subtype
  error?: ApiErrorDetails  // For api_error subtype
  retryInMs?: number  // For api_error: milliseconds until retry
  retryAttempt?: number  // For api_error: current retry attempt
  maxRetries?: number  // For api_error: maximum retries
  durationMs?: number  // For turn_duration: turn duration in ms

  // Task notification fields (when subtype === 'task_notification')
  // These fields are on the root message object (like all system messages)
  task_id?: string  // Background task ID (e.g., "bb53ba9")
  summary?: string  // Human-readable summary (e.g., 'Background command "..." completed (exit code 0)')
  output_file?: string  // Path to task output file

  // Task started fields (when subtype === 'task_started')
  // These fields are on the root message object (like all system messages)
  description?: string  // Human-readable description of the task (e.g., "Explore iOS inbox codebase")
  task_type?: string  // Type of task (e.g., "local_agent")

  // Hook started/response fields (when subtype === 'hook_started' or 'hook_response')
  hook_id?: string  // Unique identifier for this hook execution
  hook_name?: string  // Hook name (e.g., "SessionStart:startup")
  hook_event?: string  // Hook event type (e.g., "SessionStart")

  // Hook response fields (when subtype === 'hook_response')
  output?: string  // Parsed JSON output from hook
  stdout?: string  // Raw stdout from hook execution
  stderr?: string  // Raw stderr from hook execution
  exit_code?: number  // Exit code (0 = success)
  outcome?: 'success' | 'error' | string  // Hook execution outcome

  // API error indicator (for assistant messages that represent API errors)
  isApiErrorMessage?: boolean

  // Rate limit event fields (when type === 'rate_limit_event')
  // Stdout only, not persisted. Skipped in UI rendering.
  // See docs/claude-code/data-models.md "Rate Limit Event" section.
  rate_limit_info?: {
    status: string           // "allowed" or "limited"
    rateLimitType: string    // e.g., "five_hour"
    resetsAt: number         // Unix timestamp
    isUsingOverage: boolean
    overageStatus: string    // "allowed" or "blocked"
    overageResetsAt: number  // Unix timestamp
  }
  session_id?: string  // Session ID (used by some stdout-only message types)

  // Subagent linking - if set, this message belongs to a subagent spawned by the Task tool with this ID
  // See docs/claude-code/data-models.md "Subagent Message Hierarchy" section
  // NOTE: After normalization, this is always camelCase. See normalizeMessage().
  parentToolUseID?: string | null
  parent_tool_use_id?: string | null  // Pre-normalization only (from stdout)
}

// ============================================================================
// Field Name Normalization
// ============================================================================
//
// Claude Code uses inconsistent field naming between JSONL (camelCase) and
// stdout (snake_case). We normalize to camelCase at parse time.
//
// See docs/claude-code/data-models.md "Field Naming Inconsistency" section.
//
// To add a new field alias:
// 1. Add it to FIELD_ALIASES below
// 2. Document it in data-models.md
// 3. Update SessionMessage interface to use camelCase as canonical
// ============================================================================

/**
 * Field aliases: snake_case → camelCase
 * Add new entries here when discovering new inconsistent fields.
 */
const FIELD_ALIASES: Record<string, string> = {
  'tool_use_result': 'toolUseResult',
  'parent_tool_use_id': 'parentToolUseID',
}

/**
 * Normalize a message by converting snake_case fields to camelCase.
 * This ensures consistent field access regardless of message source (JSONL vs stdout).
 *
 * Call this at parse time (WebSocket handler, JSONL parser) before using the message.
 *
 * @example
 * const msg = normalizeMessage(JSON.parse(line))
 * console.log(msg.toolUseResult) // Works regardless of original field name
 */
export function normalizeMessage<T extends Record<string, unknown>>(msg: T): T {
  let hasChanges = false

  // Check if any normalization is needed
  for (const snakeCase of Object.keys(FIELD_ALIASES)) {
    if (snakeCase in msg && !(FIELD_ALIASES[snakeCase] in msg)) {
      hasChanges = true
      break
    }
  }

  // Fast path: no changes needed
  if (!hasChanges) {
    return msg
  }

  // Apply normalization
  const normalized = { ...msg }
  for (const [snakeCase, camelCase] of Object.entries(FIELD_ALIASES)) {
    if (snakeCase in normalized && !(camelCase in normalized)) {
      ;(normalized as Record<string, unknown>)[camelCase] = normalized[snakeCase]
      delete (normalized as Record<string, unknown>)[snakeCase]
    }
  }

  return normalized as T
}

/**
 * Normalize an array of messages.
 * Convenience wrapper for normalizing message arrays from JSONL or WebSocket.
 */
export function normalizeMessages<T extends Record<string, unknown>>(msgs: T[]): T[] {
  return msgs.map(normalizeMessage)
}

// System message subtypes
// See docs/claude-code/data-models.md "System Subtypes" section
export type SystemSubtype = 'init' | 'compact_boundary' | 'microcompact_boundary' | 'turn_duration' | 'api_error' | 'local_command' | 'hook_started' | 'hook_response' | 'status' | 'task_notification' | 'task_started' | string

// Compact metadata for compact_boundary messages
export interface CompactMetadata {
  trigger: 'auto' | 'manual' | string
  preTokens: number
}

// Microcompact metadata for microcompact_boundary messages
export interface MicrocompactMetadata {
  trigger: 'auto' | 'manual' | string
  preTokens: number
  tokensSaved: number
  compactedToolIds: string[]
  clearedAttachmentUUIDs: string[]
}

// API error details for api_error messages
export interface ApiErrorDetails {
  status: number
  headers?: Record<string, string>
  requestID?: string
  error?: {
    type: string
    error?: {
      type: string
      message: string
    }
  }
}

// Tool use result types - varies by tool
// See docs/claude-code/data-models.md for full schema documentation
export type ToolUseResult = string | BashToolResult | ReadToolResult | EditToolResult | GrepGlobToolResult | WebFetchToolResult | WebSearchToolResult | TaskToolResult | Record<string, unknown>

export interface BashToolResult {
  stdout?: string
  stderr?: string
  interrupted?: boolean
  isImage?: boolean
}

export interface ReadToolResult {
  type: 'text'
  file: {
    filePath: string
    content?: string
  }
}

export interface EditToolResult {
  filePath: string
  oldString?: string
  newString?: string
  originalFile?: string
  replaceAll?: boolean
  structuredPatch?: string
  userModified?: boolean
}

export interface GrepGlobToolResult {
  mode: string
  filenames?: string[]
}

export interface WebFetchToolResult {
  bytes?: number
  code?: number
  codeText?: string
  result?: string
  durationMs?: number
  url?: string
}

/**
 * Individual link result from WebSearch
 */
export interface WebSearchLinkResult {
  title: string
  url: string
}

/**
 * Container for WebSearch link results (first element of results array)
 */
export interface WebSearchResultsContainer {
  tool_use_id: string
  content: WebSearchLinkResult[]
}

/**
 * WebSearch tool result structure.
 *
 * The `results` field is a heterogeneous array:
 * - First element: Object with tool_use_id and content (array of link results)
 * - Second element: String with formatted/summarized search results
 *
 * Example:
 * ```json
 * {
 *   "query": "gold price January 2026",
 *   "results": [
 *     {
 *       "tool_use_id": "srvtoolu_...",
 *       "content": [
 *         {"title": "Gold Prices Today", "url": "https://example.com/..."},
 *         ...
 *       ]
 *     },
 *     "Based on the search results, here is the data..."
 *   ],
 *   "durationSeconds": 17.87
 * }
 * ```
 */
export interface WebSearchToolResult {
  query?: string
  results?: [WebSearchResultsContainer, string] | WebSearchLinkResult[]
  durationSeconds?: number
}

export interface TaskToolResult {
  status?: string
  prompt?: string
  // Background/local agent results have a nested task object with the full output
  retrieval_status?: string
  task?: {
    task_id?: string
    task_type?: string
    status?: string
    description?: string
    output?: string
    result?: string
    prompt?: string
  }
}

// ============================================================================
// Skipped Content Detection
// ============================================================================
//
// This module filters out system-injected XML tags from user messages.
// Used for both:
// 1. Rendering: Skip messages that are only system content
// 2. Title derivation: Backend uses same logic for first prompt extraction
//
// FILTERING LOGIC (must match backend's filterSystemTags in session_message.go):
//
// There are two types of filters:
//
// 1. PREFIX-BASED FILTERS (handled elsewhere, e.g., by isMeta flag):
//    - <ide_*>           - IDE-injected context
//    - <system-reminder> - System reminders
//    These are typically marked with isMeta=true by Claude Code.
//
// 2. TAG-BASED FILTERS (handled here):
//    - <command-name>         - Local slash command name (e.g., /clear)
//    - <command-message>      - Local command message text
//    - <command-args>         - Local command arguments
//    - <local-command-caveat> - Caveat about local commands
//    - <local-command-stdout> - Stdout from local command execution
//
//    For tag-based filters, we check:
//    a) Content contains at least one XML tag
//    b) ALL XML tags in content are in the skip list
//    c) No other content outside tags (only whitespace allowed)
//
//    This prevents accidentally filtering real user messages that might
//    contain these tags as part of legitimate content.
//
// EXAMPLES:
//   "<command-name>/clear</command-name>"                    → SKIP (only skipped tags)
//   "<command-name>/clear</command-name>\n<command-args>"    → SKIP (only skipped tags)
//   "Hello <command-name>/clear</command-name>"              → KEEP (has "Hello")
//   "<unknown-tag>foo</unknown-tag>"                         → KEEP (unknown tag)
//   "pls debug below logs"                                   → KEEP (no tags)
//
// ============================================================================

/**
 * XML tags that indicate system-injected content which should not be rendered.
 * If a user message consists ENTIRELY of these tags (no other content), skip it.
 *
 * See docs/claude-code/ui.md Section 6.3 "Skipped Message Types".
 */
const SKIPPED_XML_TAGS = new Set([
  'command-name',
  'command-message',
  'command-args',
  'local-command-caveat',
  'local-command-stdout',
])

/**
 * Check if a string content consists entirely of skipped XML tags.
 *
 * Returns true ONLY if:
 * 1. The content contains at least one XML tag
 * 2. ALL XML tags in the content are in the SKIPPED_XML_TAGS set
 * 3. There is no other content outside the tags (only whitespace allowed)
 *
 * This is strict to avoid accidentally skipping real user messages.
 */
export function isSkippedXmlContent(content: string): boolean {
  // Fast path: if content doesn't start with '<', it can't be all XML tags
  if (!content.trimStart().startsWith('<')) {
    return false
  }

  // Match XML tags: <tag-name>content</tag-name> or self-closing <tag-name/>
  // Also handles tags with attributes: <tag attr="value">content</tag>
  const tagPattern = /<([a-zA-Z][a-zA-Z0-9-]*)[^>]*>[\s\S]*?<\/\1>|<([a-zA-Z][a-zA-Z0-9-]*)[^>]*\/>/g

  const foundTags: string[] = []
  let contentWithoutTags = content

  // Find all tags and collect their names
  let match
  while ((match = tagPattern.exec(content)) !== null) {
    const tagName = match[1] || match[2] // match[1] for normal tags, match[2] for self-closing
    foundTags.push(tagName)
    // Remove this tag from the content
    contentWithoutTags = contentWithoutTags.replace(match[0], '')
  }

  // Must have at least one tag
  if (foundTags.length === 0) {
    return false
  }

  // All tags must be in the skip list
  const allTagsSkipped = foundTags.every(tag => SKIPPED_XML_TAGS.has(tag))
  if (!allTagsSkipped) {
    return false
  }

  // Remaining content (after removing tags) must be only whitespace
  const hasOtherContent = contentWithoutTags.trim().length > 0
  if (hasOtherContent) {
    return false
  }

  return true
}

/**
 * Check if a user message should be skipped because it contains only system XML tags
 * or is a system-injected task notification.
 *
 * Task notifications are injected by Claude Code when a Task sub-agent completes.
 * They contain a <task-notification> XML block with nested tags (task-id, tool-use-id,
 * status, summary, result, usage) plus trailing text outside the XML ("Full transcript
 * available at: ..."). Since there's content outside the XML tags, the generic
 * isSkippedXmlContent check won't catch them, so we use a prefix-based check instead.
 */
export function isSkippedUserMessage(msg: SessionMessage): boolean {
  if (msg.type !== 'user') return false

  const content = msg.message?.content
  if (typeof content !== 'string') return false

  // PREFIX-BASED FILTER: Skip task-notification messages (system-injected, not user-typed).
  // These have trailing text outside the XML, so isSkippedXmlContent won't catch them.
  if (content.trimStart().startsWith('<task-notification>')) return true

  return isSkippedXmlContent(content)
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a content block is a text block
 */
export function isTextBlock(block: ContentBlock): block is TextContentBlock {
  return block.type === 'text' && 'text' in block
}

/**
 * Type guard to check if a content block is a tool use block
 */
export function isToolUseBlock(block: ContentBlock): block is ToolUseContentBlock {
  return block.type === 'tool_use' && 'id' in block && 'name' in block && 'input' in block
}

/**
 * Type guard to check if a content block is a thinking block
 */
export function isThinkingBlock(block: ContentBlock): block is ThinkingContentBlock {
  return block.type === 'thinking' && 'thinking' in block
}

/**
 * Type guard to check if a content block is a tool result block
 */
export function isToolResultBlock(block: ContentBlock): block is ToolResultContentBlock {
  return block.type === 'tool_result' && 'tool_use_id' in block
}

/**
 * Type guard to check if a message is a system message
 */
export function isSystemMessage(msg: SessionMessage): boolean {
  return msg.type === 'system'
}

/**
 * Type guard to check if a message is a system init message
 */
export function isSystemInitMessage(msg: SessionMessage): boolean {
  return msg.type === 'system' && msg.subtype === 'init'
}

/**
 * Type guard to check if a message is a compact boundary message
 */
export function isCompactBoundaryMessage(msg: SessionMessage): boolean {
  return msg.type === 'system' && msg.subtype === 'compact_boundary'
}

/**
 * Type guard to check if a message is a microcompact boundary message
 */
export function isMicrocompactBoundaryMessage(msg: SessionMessage): boolean {
  return msg.type === 'system' && msg.subtype === 'microcompact_boundary'
}

/**
 * Type guard to check if a message is a compact summary (continuation message)
 */
export function isCompactSummaryMessage(msg: SessionMessage): boolean {
  return msg.type === 'user' && msg.isCompactSummary === true
}

/**
 * Type guard to check if a message is an API error message
 */
export function isApiErrorMessage(msg: SessionMessage): boolean {
  return msg.type === 'system' && msg.subtype === 'api_error'
}

/**
 * Type guard to check if a message is a turn duration message
 */
export function isTurnDurationMessage(msg: SessionMessage): boolean {
  return msg.type === 'system' && msg.subtype === 'turn_duration'
}

/**
 * Type guard to check if a message is a hook started message
 */
export function isHookStartedMessage(msg: SessionMessage): boolean {
  return msg.type === 'system' && msg.subtype === 'hook_started'
}

/**
 * Type guard to check if a message is a hook response message
 */
export function isHookResponseMessage(msg: SessionMessage): boolean {
  return msg.type === 'system' && msg.subtype === 'hook_response'
}

/**
 * Type guard to check if a message is a status message.
 * Status messages are ephemeral indicators of session state (e.g., "compacting").
 * They are skipped from rendering because the final state is shown by other messages
 * (e.g., compact_boundary shows "Session compacted" after compaction is complete).
 */
export function isStatusMessage(msg: SessionMessage): boolean {
  return msg.type === 'system' && msg.subtype === 'status'
}

/**
 * Type guard to check if a message is a task notification message.
 * Task notifications are sent when a background task (e.g., a background shell command
 * launched via the Task tool) completes. They include a summary, task_id, status, and
 * output_file path.
 */
export function isTaskNotificationMessage(msg: SessionMessage): boolean {
  return msg.type === 'system' && msg.subtype === 'task_notification'
}

/**
 * Type guard to check if a message is a task started message.
 * Task started messages are emitted when a background task (spawned by the Task tool)
 * begins execution. They include a description, task_id, and task_type.
 */
export function isTaskStartedMessage(msg: SessionMessage): boolean {
  return msg.type === 'system' && msg.subtype === 'task_started'
}

/**
 * Summary message interface (automatic conversation summarization)
 */
export interface SummaryMessage extends SessionMessage {
  type: 'summary'
  summary: string
  leafUuid: string
}

/**
 * Type guard to check if a message is a summary message
 */
export function isSummaryMessage(msg: SessionMessage): msg is SummaryMessage {
  return msg.type === 'summary' && 'summary' in msg
}

/**
 * Type guard to check if toolUseResult is a string (error format)
 */
export function isToolResultError(result: ToolUseResult | undefined): result is string {
  return typeof result === 'string'
}

/**
 * Type guard to check if toolUseResult is a Bash result
 */
export function isBashToolResult(result: ToolUseResult | undefined): result is BashToolResult {
  return typeof result === 'object' && result !== null && ('stdout' in result || 'stderr' in result)
}

/**
 * Type guard to check if toolUseResult is a Read result
 */
export function isReadToolResult(result: ToolUseResult | undefined): result is ReadToolResult {
  return typeof result === 'object' && result !== null && 'type' in result && result.type === 'text' && 'file' in result
}

/**
 * Type guard to check if toolUseResult is an Edit result
 */
export function isEditToolResult(result: ToolUseResult | undefined): result is EditToolResult {
  return typeof result === 'object' && result !== null && 'filePath' in result && ('oldString' in result || 'newString' in result)
}

/**
 * Type guard to check if toolUseResult is a WebFetch result
 */
export function isWebFetchToolResult(result: ToolUseResult | undefined): result is WebFetchToolResult {
  return typeof result === 'object' && result !== null && 'bytes' in result && 'code' in result
}

/**
 * Tool result with all relevant fields extracted from the message
 */
export interface ExtractedToolResult {
  toolUseId: string
  content: string  // The content from tool_result block
  isError: boolean
  toolUseResult: ToolUseResult | undefined  // The rich metadata (stdout/stderr for Bash, etc.)
}

/**
 * Get the tool use result from a message, handling both field naming conventions.
 *
 * After normalizeMessage() is called, only toolUseResult (camelCase) should exist.
 * This accessor checks both for backwards compatibility with non-normalized messages.
 *
 * Prefer using msg.toolUseResult directly if you know the message is normalized.
 */
export function getToolUseResult(msg: SessionMessage): ToolUseResult | undefined {
  return msg.toolUseResult ?? msg.tool_use_result
}

/**
 * Check if a message has a tool use result (either field naming convention)
 *
 * After normalizeMessage() is called, only toolUseResult (camelCase) should exist.
 */
export function hasToolUseResult(msg: SessionMessage): boolean {
  return msg.toolUseResult !== undefined || msg.tool_use_result !== undefined
}

/**
 * Get the parent tool use ID from a message, handling both field naming conventions.
 *
 * After normalizeMessage() is called, only parentToolUseID (camelCase) should exist.
 * This accessor checks both for backwards compatibility with non-normalized messages.
 *
 * Prefer using msg.parentToolUseID directly if you know the message is normalized.
 */
export function getParentToolUseID(msg: SessionMessage): string | null | undefined {
  return msg.parentToolUseID ?? msg.parent_tool_use_id
}

/**
 * Check if a message is a subagent message (has a parent tool use ID)
 *
 * After normalizeMessage() is called, only parentToolUseID (camelCase) should exist.
 */
export function isSubagentMessage(msg: SessionMessage): boolean {
  return getParentToolUseID(msg) != null
}

/**
 * Build a mapping from tool_use_id to tool result
 * Tool results are stored in 'user' type messages with tool_result blocks in message.content
 *
 * Some messages also have a root-level toolUseResult/tool_use_result field with rich metadata
 * (stdout/stderr for Bash, filePath for Read, etc.), but this is optional.
 */
export function buildToolResultMap(messages: SessionMessage[]): Map<string, ExtractedToolResult> {
  const resultMap = new Map<string, ExtractedToolResult>()

  for (const msg of messages) {
    // Tool results are in 'user' type messages
    if (msg.type !== 'user') continue

    // Extract tool_use_id from message.content
    const content = msg.message?.content
    if (!Array.isArray(content)) continue

    // Rich metadata is optional - some messages only have tool_result blocks without it
    const toolUseResult = getToolUseResult(msg)

    for (const block of content) {
      if (isToolResultBlock(block)) {
        resultMap.set(block.tool_use_id, {
          toolUseId: block.tool_use_id,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          isError: block.is_error ?? false,
          toolUseResult,
        })
      }
    }
  }

  return resultMap
}
