import { useState } from 'react'
import type { ToolCall, ToolName } from '~/types/claude'

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

function GenericToolView({ toolCall }: { toolCall: ToolCall }) {
  return (
    <div className="space-y-2">
      {/* Parameters */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">Parameters</div>
        <pre
          className="text-xs rounded p-2 overflow-x-auto"
          style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
        >
          {JSON.stringify(toolCall.parameters, null, 2)}
        </pre>
      </div>

      {/* Result */}
      {toolCall.result !== undefined && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">Result</div>
          <pre
            className="text-xs rounded p-2 overflow-x-auto max-h-48 overflow-y-auto"
            style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
          >
            {typeof toolCall.result === 'string'
              ? toolCall.result
              : JSON.stringify(toolCall.result, null, 2)}
          </pre>
        </div>
      )}

      {/* Error */}
      {toolCall.error && (
        <div>
          <div className="text-xs text-red-500 mb-1">Error</div>
          <pre className="text-xs bg-red-500/10 text-red-500 rounded p-2">
            {toolCall.error}
          </pre>
        </div>
      )}
    </div>
  )
}
