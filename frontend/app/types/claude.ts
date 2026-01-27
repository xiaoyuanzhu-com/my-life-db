// Claude Code Web UI Types
// Based on the message protocol used by Claude Code

// Tool names supported by Claude Code
export type ToolName =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'Bash'
  | 'Glob'
  | 'Grep'
  | 'WebFetch'
  | 'WebSearch'
  | 'Task'
  | 'TodoWrite'
  | 'AskUserQuestion'
  | 'NotebookEdit'
  | 'Skill'
  | 'KillShell'
  | 'TaskOutput'

// Tool call status
export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'permission_required'

// Permission modes
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

// Session status
export type SessionStatus = 'active' | 'idle' | 'disconnected'

// Todo item status
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

// ============================================================================
// Tool-specific parameter types
// ============================================================================

export interface ReadToolParams {
  file_path: string
  offset?: number
  limit?: number
}

export interface WriteToolParams {
  file_path: string
  content: string
}

export interface EditToolParams {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export interface BashToolParams {
  command: string
  description?: string
  timeout?: number
  run_in_background?: boolean
}

export interface GlobToolParams {
  pattern: string
  path?: string
}

export interface GrepToolParams {
  pattern: string
  path?: string
  glob?: string
  type?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-i'?: boolean
  '-n'?: boolean
  '-A'?: number
  '-B'?: number
  '-C'?: number
}

export interface WebFetchToolParams {
  url: string
  prompt: string
}

export interface WebSearchToolParams {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}

export interface TaskToolParams {
  description: string
  prompt: string
  subagent_type: string
  model?: 'sonnet' | 'opus' | 'haiku'
  run_in_background?: boolean
  resume?: string
}

export interface AskUserQuestionParams {
  questions: {
    question: string
    header: string
    options: {
      label: string
      description: string
    }[]
    multiSelect: boolean
  }[]
  answers?: Record<string, string>
}

export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm: string
}

export interface TodoWriteParams {
  todos: TodoItem[]
}

// Union type for all tool parameters
export type ToolParams =
  | ReadToolParams
  | WriteToolParams
  | EditToolParams
  | BashToolParams
  | GlobToolParams
  | GrepToolParams
  | WebFetchToolParams
  | WebSearchToolParams
  | TaskToolParams
  | AskUserQuestionParams
  | TodoWriteParams
  | Record<string, unknown>

// ============================================================================
// Tool results
// ============================================================================

export interface ReadToolResult {
  content: string
  lineCount: number
  truncated?: boolean
}

export interface GlobToolResult {
  files: string[]
  count: number
}

export interface GrepToolResult {
  files?: string[]
  content?: string
  count?: number
}

export interface BashToolResult {
  output: string
  exitCode: number
  duration?: number
}

export interface WebFetchToolResult {
  bytes: number
  code: number
  codeText: string
  result: string
  durationMs: number
  url: string
}

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchToolResult {
  results: WebSearchResult[]
}

// ============================================================================
// Core message types
// ============================================================================

export interface ToolCall {
  id: string
  name: ToolName
  parameters: ToolParams
  status: ToolStatus
  result?: unknown
  error?: string
  duration?: number
  startTime?: number
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls?: ToolCall[]
  thinking?: ThinkingBlock[]
  timestamp: number
  isStreaming?: boolean
  isOptimistic?: boolean  // Temporary message, will be replaced by server
  systemType?: string  // Original message type for system messages (debugging)
}

// ============================================================================
// Control Protocol (Permission Requests/Responses)
// ============================================================================

// Raw control_request from Claude CLI stdout
export interface ControlRequest {
  type: 'control_request'
  request_id: string
  request: {
    subtype: 'can_use_tool'
    tool_name: string
    input: Record<string, unknown>
  }
}

// control_response to send via stdin
export interface ControlResponse {
  type: 'control_response'
  request_id: string
  response: {
    subtype: 'success'
    response: {
      behavior: 'allow' | 'deny'
    }
  }
}

// UI-friendly permission request (derived from ControlRequest)
export interface PermissionRequest {
  requestId: string      // from control_request.request_id
  toolName: string       // from control_request.request.tool_name
  input: Record<string, unknown>  // from control_request.request.input
}

export type PermissionDecision = 'allow' | 'deny'

// ============================================================================
// User question (from AskUserQuestion tool)
// ============================================================================

export interface UserQuestion {
  id: string
  toolCallId: string
  questions: {
    question: string
    header: string
    options: {
      label: string
      description: string
    }[]
    multiSelect: boolean
  }[]
}

// ============================================================================
// Session
// ============================================================================

export interface ClaudeSession {
  id: string
  name: string
  createdAt: number
  lastActivity: number
  status: SessionStatus
  workingDir: string
  model: string
  permissionMode: PermissionMode
  messages: Message[]
  todos: TodoItem[]
  tokenUsage: {
    used: number
    limit: number
  }
}

// ============================================================================
// WebSocket/SSE message types
// ============================================================================

export type MessageType =
  | 'connected'
  | 'text_delta'
  | 'text_complete'
  | 'tool_use'
  | 'tool_result'
  | 'control_request'  // Permission request from Claude CLI
  | 'user_question'
  | 'todo_update'
  | 'error'
  | 'session_update'

export interface WSMessage {
  type: MessageType
  messageId?: string
  data: unknown
}

export interface TextDeltaMessage extends WSMessage {
  type: 'text_delta'
  data: {
    delta: string
    messageId: string
  }
}

export interface ToolUseMessage extends WSMessage {
  type: 'tool_use'
  data: ToolCall
}

export interface ToolResultMessage extends WSMessage {
  type: 'tool_result'
  data: {
    toolCallId: string
    result: unknown
    error?: string
    duration?: number
  }
}

export interface ControlRequestMessage extends WSMessage {
  type: 'control_request'
  data: ControlRequest
}

export interface UserQuestionMessage extends WSMessage {
  type: 'user_question'
  data: UserQuestion
}

export interface TodoUpdateMessage extends WSMessage {
  type: 'todo_update'
  data: {
    todos: TodoItem[]
  }
}

// ============================================================================
// API request/response types
// ============================================================================

export interface SendMessageRequest {
  content: string
  attachments?: {
    type: 'file' | 'image'
    path: string
  }[]
}

export interface PermissionDecisionRequest {
  requestId: string
  decision: PermissionDecision
}

export interface QuestionAnswerRequest {
  questionId: string
  answers: Record<string, string | string[]>
}

// ============================================================================
// Component props helpers
// ============================================================================

export interface ToolBlockProps {
  toolCall: ToolCall
  onApprove?: (id: string) => void
  onDeny?: (id: string) => void
}

export interface MessageProps {
  message: Message
}

// ============================================================================
// System Init Message (type: "system", subtype: "init")
// ============================================================================

export interface MCPServer {
  name: string
  status: 'connected' | 'disabled' | string
}

export interface PluginInfo {
  name: string
  path: string
}

export interface SystemInitData {
  type: 'system'
  subtype: 'init'
  cwd: string
  session_id: string
  tools: string[]
  mcp_servers: MCPServer[]
  model: string
  permissionMode: string
  slash_commands: string[]
  apiKeySource: string
  claude_code_version: string
  output_style: string
  agents: string[]
  skills: string[]
  plugins: PluginInfo[]
  uuid: string
}
