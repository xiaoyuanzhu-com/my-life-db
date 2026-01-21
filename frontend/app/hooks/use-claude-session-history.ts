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

// Message structure in JSONL files
export interface ClaudeMessage {
  role: 'user' | 'assistant'
  // User messages: string content
  // Assistant messages: array of content blocks
  content: string | ContentBlock[]
  model?: string
  id?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
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
  toolUseResult?: {
    toolUseId?: string
    isError?: boolean
  }
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
