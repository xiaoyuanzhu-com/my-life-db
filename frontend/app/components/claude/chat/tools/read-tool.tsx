import { FileText } from 'lucide-react'
import type { ToolCall, ReadToolParams, ReadToolResult } from '~/types/claude'

interface ReadToolViewProps {
  toolCall: ToolCall
}

export function ReadToolView({ toolCall }: ReadToolViewProps) {
  const params = toolCall.parameters as ReadToolParams
  const result = toolCall.result as ReadToolResult | string | undefined

  // Extract filename from path
  const filename = params.file_path.split('/').pop() || params.file_path

  // Determine file extension for syntax highlighting hint
  const ext = filename.split('.').pop()?.toLowerCase()

  return (
    <div className="space-y-2">
      {/* File path */}
      <div className="flex items-center gap-2 text-sm">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <span className="font-mono text-xs truncate">{params.file_path}</span>
        {params.offset !== undefined && (
          <span className="text-xs text-muted-foreground">
            (lines {params.offset}-{params.offset + (params.limit || 2000)})
          </span>
        )}
      </div>

      {/* Content */}
      {result && (
        <div className="relative">
          {/* Language badge */}
          {ext && (
            <div className="absolute top-2 right-2 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {ext}
            </div>
          )}
          <pre className="text-xs font-mono bg-background rounded-md p-3 overflow-x-auto max-h-64 overflow-y-auto">
            <code>
              {typeof result === 'string' ? result : result.content}
            </code>
          </pre>
          {typeof result === 'object' && result.truncated && (
            <div className="text-xs text-muted-foreground mt-1">
              Content truncated ({result.lineCount} total lines)
            </div>
          )}
        </div>
      )}
    </div>
  )
}
