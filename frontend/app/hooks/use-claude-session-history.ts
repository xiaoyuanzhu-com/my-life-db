import { useState, useEffect } from 'react'

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
  userType?: string
  cwd?: string
  sessionId?: string
  version?: string
  gitBranch?: string
  requestId?: string
  sourceToolAssistantUUID?: string // For tool results: UUID of the assistant message that initiated the tool call

  // Tool use result - varies by tool type (see docs/claude-code/data-models.md)
  // Can be string (for errors) or object (for success with tool-specific fields)
  toolUseResult?: ToolUseResult
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

export interface UseClaudeSessionHistoryResult {
  messages: SessionMessage[]
  isLoading: boolean
  error: string | null
  refetch: () => Promise<void>
}

/**
 * Hook to fetch structured session history from Claude Code JSONL files
 * @param sessionId - Claude session UUID
 * @returns Session messages, loading state, error state, and refetch function
 */
export function useClaudeSessionHistory(
  sessionId: string | null
): UseClaudeSessionHistoryResult {
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchHistory = async () => {
    if (!sessionId) {
      setMessages([])
      setIsLoading(false)
      return
    }

    console.log('[useClaudeSessionHistory] Fetching history for session:', sessionId)
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/claude/sessions/${sessionId}/history`)

      if (!response.ok) {
        throw new Error(`Failed to fetch session history: ${response.statusText}`)
      }

      const data = await response.json()
      console.log('[useClaudeSessionHistory] Fetched history, message count:', data.messages?.length || 0)
      setMessages(data.messages || [])
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      setError(errorMessage)
      console.error('Error fetching Claude session history:', err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchHistory()
  }, [sessionId])

  return {
    messages,
    isLoading,
    error,
    refetch: fetchHistory,
  }
}

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
 * Filter messages to only include user and assistant messages (skip internal events)
 */
export function filterConversationMessages(messages: SessionMessage[]): SessionMessage[] {
  return messages.filter(
    (msg) =>
      msg.type === 'user' ||
      msg.type === 'assistant'
  )
}

/**
 * Build a message tree from flat array using uuid/parentUuid relationships
 */
export interface MessageNode extends SessionMessage {
  children: MessageNode[]
}

export function buildMessageTree(messages: SessionMessage[]): MessageNode[] {
  const byUuid = new Map<string, MessageNode>()
  const roots: MessageNode[] = []

  // Create nodes
  for (const msg of messages) {
    byUuid.set(msg.uuid, { ...msg, children: [] })
  }

  // Build tree
  for (const msg of messages) {
    const node = byUuid.get(msg.uuid)!

    if (!msg.parentUuid) {
      roots.push(node)
    } else {
      const parent = byUuid.get(msg.parentUuid)
      if (parent) {
        parent.children.push(node)
      } else {
        // Parent not found, treat as root
        roots.push(node)
      }
    }
  }

  return roots
}
