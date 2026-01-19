import { Bot, Play, Clock } from 'lucide-react'
import type { ToolCall, TaskToolParams } from '~/types/claude'

interface TaskToolViewProps {
  toolCall: ToolCall
}

export function TaskToolView({ toolCall }: TaskToolViewProps) {
  const params = toolCall.parameters as TaskToolParams
  const result = toolCall.result as string | undefined

  // Model badge color
  const modelColors: Record<string, string> = {
    opus: 'bg-purple-500/20 text-purple-500',
    sonnet: 'bg-blue-500/20 text-blue-500',
    haiku: 'bg-green-500/20 text-green-500',
  }

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <Bot className="h-4 w-4 text-indigo-500" />
        <span className="text-xs font-medium">{params.description}</span>
        <span className="text-xs bg-muted px-1.5 py-0.5 rounded">
          {params.subagent_type}
        </span>
        {params.model && (
          <span className={`text-xs px-1.5 py-0.5 rounded ${modelColors[params.model] || 'bg-muted'}`}>
            {params.model}
          </span>
        )}
        {params.run_in_background && (
          <span className="text-xs bg-muted px-1.5 py-0.5 rounded flex items-center gap-1">
            <Clock className="h-3 w-3" />
            background
          </span>
        )}
      </div>

      {/* Prompt (collapsed by default for long prompts) */}
      <div className="text-xs text-muted-foreground">
        <details>
          <summary className="cursor-pointer hover:text-foreground">
            View prompt
          </summary>
          <pre className="mt-2 p-2 bg-background rounded text-xs whitespace-pre-wrap">
            {params.prompt}
          </pre>
        </details>
      </div>

      {/* Running indicator */}
      {(toolCall.status === 'running' || toolCall.status === 'pending') && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Play className="h-3 w-3 animate-pulse" />
          Agent is working...
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="rounded-md bg-background border border-border p-3 text-sm max-h-64 overflow-y-auto">
          {result}
        </div>
      )}
    </div>
  )
}
