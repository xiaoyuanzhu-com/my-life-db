import { useState, useEffect } from 'react'

// Session message from Claude Code JSONL files
export interface SessionMessage {
  type: string // "user", "assistant", "tool_result", "queue-operation", etc.
  uuid: string
  parentUuid?: string | null
  timestamp: string
  message?: {
    role?: 'user' | 'assistant'
    content?: Array<{
      type: string
      text?: string
      tool_use_id?: string
      id?: string
      name?: string
      input?: Record<string, unknown>
      [key: string]: unknown
    }>
    model?: string
    id?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }

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

    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/claude/sessions/${sessionId}/history`)

      if (!response.ok) {
        throw new Error(`Failed to fetch session history: ${response.statusText}`)
      }

      const data = await response.json()
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
