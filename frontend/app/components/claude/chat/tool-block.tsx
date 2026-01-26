import { useState, useEffect } from 'react'
import type { ToolCall, ToolName } from '~/types/claude'
import { MessageDot } from './message-dot'

// Tool-specific visualizations
import { ReadToolView } from './tools/read-tool'
import { WriteToolView } from './tools/write-tool'
import { EditToolView } from './tools/edit-tool'
import { BashToolView } from './tools/bash-tool'
import { GlobToolView } from './tools/glob-tool'
import { GrepToolView } from './tools/grep-tool'
import { WebFetchToolView } from './tools/web-fetch-tool'
import { WebSearchToolView } from './tools/web-search-tool'
import { TaskToolView } from './tools/task-tool'
import { TodoToolView } from './tools/todo-tool'

interface ToolBlockProps {
  toolCall: ToolCall
}

// Get tool summary for collapsed view
function getToolSummary(toolCall: ToolCall): string {
  const params = toolCall.parameters

  switch (toolCall.name) {
    case 'Read':
      return params.file_path || 'file'
    case 'Write':
      return params.file_path || 'file'
    case 'Edit':
      return params.file_path || 'file'
    case 'Bash':
      return params.command || 'command'
    case 'Glob':
      return params.pattern || 'pattern'
    case 'Grep':
      return params.pattern || 'pattern'
    case 'WebFetch':
      return params.url || 'URL'
    case 'WebSearch':
      return params.query || 'query'
    case 'Task':
      return params.description || 'task'
    case 'TodoWrite':
      return `${params.todos?.length || 0} items`
    default:
      return ''
  }
}

export function ToolBlock({ toolCall }: ToolBlockProps) {
  // Tool components are now self-contained with their own headers and collapse/expand logic
  // Just render them directly
  return <ToolContent toolCall={toolCall} />
}

function ToolContent({ toolCall }: { toolCall: ToolCall }) {
  // Render tool-specific view based on tool name
  switch (toolCall.name) {
    case 'Read':
      return <ReadToolView toolCall={toolCall} />
    case 'Write':
      return <WriteToolView toolCall={toolCall} />
    case 'Edit':
      return <EditToolView toolCall={toolCall} />
    case 'Bash':
      return <BashToolView toolCall={toolCall} />
    case 'Glob':
      return <GlobToolView toolCall={toolCall} />
    case 'Grep':
      return <GrepToolView toolCall={toolCall} />
    case 'WebFetch':
      return <WebFetchToolView toolCall={toolCall} />
    case 'WebSearch':
      return <WebSearchToolView toolCall={toolCall} />
    case 'Task':
      return <TaskToolView toolCall={toolCall} />
    case 'TodoWrite':
      return <TodoToolView toolCall={toolCall} />
    default:
      return <GenericToolView toolCall={toolCall} />
  }
}

// Convert PascalCase/camelCase to Title Case with spaces
function formatToolName(name: string): string {
  // Handle common tool names
  const overrides: Record<string, string> = {
    'ExitPlanMode': 'Exit Plan Mode',
    'EnterPlanMode': 'Enter Plan Mode',
    'AskUserQuestion': 'Ask User Question',
    'WebFetch': 'Web Fetch',
    'WebSearch': 'Web Search',
    'TodoWrite': 'Todo Write',
    'TaskCreate': 'Task Create',
    'TaskUpdate': 'Task Update',
    'TaskList': 'Task List',
    'TaskGet': 'Task Get',
  }

  if (overrides[name]) return overrides[name]

  // Generic PascalCase to Title Case
  return name.replace(/([A-Z])/g, ' $1').trim()
}

// Check if content looks like markdown (has headers, lists, code blocks, etc.)
function isMarkdownContent(content: string): boolean {
  if (!content || typeof content !== 'string') return false
  // Check for markdown indicators
  return /^#+ /m.test(content) || // Headers
         /^\s*[-*] /m.test(content) || // Lists
         /```[\s\S]*```/.test(content) || // Code blocks
         /^\|.*\|$/m.test(content) // Tables
}

// Get the primary content from parameters (for markdown rendering)
function getPrimaryContent(params: Record<string, unknown>): string | null {
  // Common parameter names that might contain markdown
  const contentKeys = ['plan', 'content', 'message', 'description', 'text', 'body']

  for (const key of contentKeys) {
    const value = params[key]
    if (typeof value === 'string' && isMarkdownContent(value)) {
      return value
    }
  }

  return null
}

function GenericToolView({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false)

  const params = toolCall.parameters as Record<string, unknown>
  const displayName = formatToolName(toolCall.name)
  const markdownContent = getPrimaryContent(params)
  const hasMarkdownContent = markdownContent !== null

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + tool name + chevron */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-2 w-full text-left hover:opacity-80 transition-opacity"
      >
        <MessageDot status={toolCall.status} />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            {displayName}
          </span>
          <span
            className="select-none text-[11px]"
            style={{ color: 'var(--claude-text-tertiary)' }}
          >
            {expanded ? '▾' : '▸'}
          </span>
        </div>
      </button>

      {/* Error indicator (always visible) */}
      {toolCall.error && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-status-alert)' }}>
          <span className="select-none">└</span>
          <span>{toolCall.error.slice(0, 100)}{toolCall.error.length > 100 ? '...' : ''}</span>
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <div className="mt-2 ml-5">
          {hasMarkdownContent ? (
            <MarkdownContentView content={markdownContent!} />
          ) : (
            <JsonParamsView params={params} result={toolCall.result} error={toolCall.error} />
          )}
        </div>
      )}
    </div>
  )
}

// Markdown content renderer for plan-like tools
function MarkdownContentView({ content }: { content: string }) {
  const [html, setHtml] = useState('')

  useEffect(() => {
    let cancelled = false

    import('~/lib/shiki').then(({ parseMarkdown }) => {
      parseMarkdown(content).then((parsed) => {
        if (!cancelled) setHtml(parsed)
      })
    })

    return () => {
      cancelled = true
    }
  }, [content])

  return (
    <div
      className="prose-claude rounded-md p-4 overflow-y-auto"
      style={{
        backgroundColor: 'var(--claude-bg-code-block)',
        maxHeight: '60vh',
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// Fallback JSON view for generic parameters
function JsonParamsView({
  params,
  result,
  error,
}: {
  params: Record<string, unknown>
  result?: unknown
  error?: string
}) {
  const paramsJson = JSON.stringify(params, null, 2)
  const resultStr = result !== undefined
    ? (typeof result === 'string' ? result : JSON.stringify(result, null, 2))
    : null

  return (
    <div
      className="rounded-md overflow-hidden"
      style={{ border: '1px solid var(--claude-border-light)' }}
    >
      {/* Parameters */}
      <div
        className="p-3"
        style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
      >
        <div
          className="text-[11px] font-semibold mb-1"
          style={{ color: 'var(--claude-text-tertiary)' }}
        >
          Parameters
        </div>
        <pre className="text-[12px] whitespace-pre-wrap overflow-x-auto">
          {paramsJson}
        </pre>
      </div>

      {/* Result */}
      {resultStr && (
        <div
          className="p-3"
          style={{
            backgroundColor: 'var(--claude-bg-code-block)',
            borderTop: '1px solid var(--claude-border-light)',
          }}
        >
          <div
            className="text-[11px] font-semibold mb-1"
            style={{ color: 'var(--claude-text-tertiary)' }}
          >
            Result
          </div>
          <pre className="text-[12px] whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto">
            {resultStr}
          </pre>
        </div>
      )}

      {/* Error details */}
      {error && (
        <div
          className="p-3"
          style={{
            backgroundColor: 'var(--claude-bg-code-block)',
            borderTop: '1px solid var(--claude-border-light)',
          }}
        >
          <div className="text-[11px] font-semibold mb-1 text-red-500">
            Error
          </div>
          <pre className="text-[12px] whitespace-pre-wrap text-red-500">
            {error}
          </pre>
        </div>
      )}
    </div>
  )
}
