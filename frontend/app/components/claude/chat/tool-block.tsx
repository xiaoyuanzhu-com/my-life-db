import { useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Check, X, AlertCircle } from 'lucide-react'
import { cn } from '~/lib/utils'
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

interface ToolBlockProps {
  toolCall: ToolCall
}

// Tool icon and color mapping
const toolMeta: Record<ToolName, { icon: string; color: string }> = {
  Read: { icon: '📖', color: 'bg-blue-500/10 border-blue-500/30' },
  Write: { icon: '✏️', color: 'bg-green-500/10 border-green-500/30' },
  Edit: { icon: '📝', color: 'bg-yellow-500/10 border-yellow-500/30' },
  Bash: { icon: '💻', color: 'bg-purple-500/10 border-purple-500/30' },
  Glob: { icon: '🔍', color: 'bg-cyan-500/10 border-cyan-500/30' },
  Grep: { icon: '🔎', color: 'bg-cyan-500/10 border-cyan-500/30' },
  WebFetch: { icon: '🌐', color: 'bg-orange-500/10 border-orange-500/30' },
  WebSearch: { icon: '🔍', color: 'bg-orange-500/10 border-orange-500/30' },
  Task: { icon: '🤖', color: 'bg-indigo-500/10 border-indigo-500/30' },
  TodoWrite: { icon: '📋', color: 'bg-pink-500/10 border-pink-500/30' },
  AskUserQuestion: { icon: '❓', color: 'bg-amber-500/10 border-amber-500/30' },
  NotebookEdit: { icon: '📓', color: 'bg-teal-500/10 border-teal-500/30' },
  Skill: { icon: '⚡', color: 'bg-violet-500/10 border-violet-500/30' },
  KillShell: { icon: '🛑', color: 'bg-red-500/10 border-red-500/30' },
  TaskOutput: { icon: '📤', color: 'bg-gray-500/10 border-gray-500/30' },
}

export function ToolBlock({ toolCall }: ToolBlockProps) {
  const [isExpanded, setIsExpanded] = useState(true)
  const meta = toolMeta[toolCall.name] || { icon: '🔧', color: 'bg-muted' }

  const statusIcon = () => {
    switch (toolCall.status) {
      case 'running':
      case 'pending':
        return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      case 'completed':
        return <Check className="h-3 w-3 text-green-500" />
      case 'failed':
        return <X className="h-3 w-3 text-red-500" />
      case 'permission_required':
        return <AlertCircle className="h-3 w-3 text-yellow-500" />
      default:
        return null
    }
  }

  return (
    <div
      className={cn(
        'rounded-lg border text-left',
        meta.color
      )}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <span>{meta.icon}</span>
        <span className="font-medium">{toolCall.name}</span>
        <span className="flex-1" />
        {statusIcon()}
        {toolCall.duration && (
          <span className="text-xs text-muted-foreground">
            {(toolCall.duration / 1000).toFixed(1)}s
          </span>
        )}
      </button>

      {/* Content */}
      {isExpanded && (
        <div className="border-t border-border/50 px-3 py-2">
          <ToolContent toolCall={toolCall} />
        </div>
      )}
    </div>
  )
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
        <pre className="text-xs bg-background/50 rounded p-2 overflow-x-auto">
          {JSON.stringify(toolCall.parameters, null, 2)}
        </pre>
      </div>

      {/* Result */}
      {toolCall.result !== undefined && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">Result</div>
          <pre className="text-xs bg-background/50 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">
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
