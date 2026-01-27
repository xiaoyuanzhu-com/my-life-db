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
  //
  // IMPORTANT: Claude Code has inconsistent field naming between output formats:
  // - JSONL files (historical sessions): uses camelCase "toolUseResult"
  // - stdout (stream-json, live sessions): uses snake_case "tool_use_result"
  // We handle both to support viewing historical sessions and live WebSocket streams.
  // See docs/claude-code/data-models.md "Field Naming Inconsistency" section.
  toolUseResult?: ToolUseResult
  tool_use_result?: ToolUseResult  // snake_case variant from stdout

  // System message fields (when type === 'system')
  // IMPORTANT: System messages do NOT have a `message` field - their data is on the root object
  // See docs/claude-code/data-models.md "System Messages" section
  subtype?: SystemSubtype
  content?: string  // Human-readable message for system events
  level?: 'info' | 'error'
  logicalParentUuid?: string  // For compact_boundary: logical parent (different from parentUuid)
  compactMetadata?: CompactMetadata
  error?: ApiErrorDetails  // For api_error subtype
  retryInMs?: number  // For api_error: milliseconds until retry
  retryAttempt?: number  // For api_error: current retry attempt
  maxRetries?: number  // For api_error: maximum retries
  durationMs?: number  // For turn_duration: turn duration in ms
}

// System message subtypes
// See docs/claude-code/data-models.md "System Subtypes" section
export type SystemSubtype = 'init' | 'compact_boundary' | 'turn_duration' | 'api_error' | 'local_command' | string

// Compact metadata for compact_boundary messages
export interface CompactMetadata {
  trigger: 'auto' | 'manual' | string
  preTokens: number
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

export interface WebSearchToolResult {
  query?: string
}

export interface TaskToolResult {
  status?: string
  prompt?: string
}

// ============================================================================
// Skipped Content Detection
// ============================================================================

/**
 * XML tags that indicate system-injected content which should not be rendered.
 * If a user message consists ENTIRELY of these tags (no other content), skip it.
 *
 * See docs/claude-code/ui.md "Skipped Message Types" for documentation.
 */
const SKIPPED_XML_TAGS = new Set([
  'command-name',         // Local command name (e.g., /clear, /doctor)
  'command-message',      // Local command message
  'command-args',         // Local command arguments
  'local-command-caveat', // Caveat about local commands (usually with isMeta)
  'local-command-stdout', // Stdout from local command execution
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
 * Check if a user message should be skipped because it contains only system XML tags.
 */
export function isSkippedUserMessage(msg: SessionMessage): boolean {
  if (msg.type !== 'user') return false

  const content = msg.message?.content
  if (typeof content !== 'string') return false

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
 * Claude Code has inconsistent field naming between output formats:
 * - JSONL files (historical sessions): uses camelCase "toolUseResult"
 * - stdout (stream-json, live sessions): uses snake_case "tool_use_result"
 *
 * This helper normalizes access to support both sources.
 */
export function getToolUseResult(msg: SessionMessage): ToolUseResult | undefined {
  return msg.toolUseResult ?? msg.tool_use_result
}

/**
 * Check if a message has a tool use result (either field naming convention)
 */
export function hasToolUseResult(msg: SessionMessage): boolean {
  return msg.toolUseResult !== undefined || msg.tool_use_result !== undefined
}

/**
 * Build a mapping from tool_use_id to tool result
 * Tool results are stored in 'user' type messages that have toolUseResult/tool_use_result field
 */
export function buildToolResultMap(messages: SessionMessage[]): Map<string, ExtractedToolResult> {
  const resultMap = new Map<string, ExtractedToolResult>()

  for (const msg of messages) {
    // Tool results are in 'user' type messages with toolUseResult or tool_use_result field
    // (Claude uses different naming in JSONL vs stdout - see getToolUseResult comments)
    if (msg.type !== 'user' || !hasToolUseResult(msg)) continue

    // Extract tool_use_id from message.content
    const content = msg.message?.content
    if (!Array.isArray(content)) continue

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
