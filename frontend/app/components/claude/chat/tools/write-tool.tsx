import { useState } from 'react'
import { FilePlus, ChevronDown, ChevronRight } from 'lucide-react'
import type { ToolCall, WriteToolParams } from '~/types/claude'

interface WriteToolViewProps {
  toolCall: ToolCall
}

export function WriteToolView({ toolCall }: WriteToolViewProps) {
  const params = toolCall.parameters as WriteToolParams
  const [showContent, setShowContent] = useState(false)

  // Extract filename
  const filename = params.file_path.split('/').pop() || params.file_path
  const ext = filename.split('.').pop()?.toLowerCase()

  // Preview first few lines
  const lines = params.content.split('\n')
  const previewLines = lines.slice(0, 5)
  const hasMore = lines.length > 5

  return (
    <div className="space-y-2">
      {/* File path */}
      <div className="flex items-center gap-2 text-sm">
        <FilePlus className="h-4 w-4 text-green-500" />
        <span className="font-mono text-xs truncate">{params.file_path}</span>
        <span className="text-xs text-muted-foreground">
          ({lines.length} lines)
        </span>
      </div>

      {/* Content toggle */}
      <button
        type="button"
        onClick={() => setShowContent(!showContent)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {showContent ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {showContent ? 'Hide content' : 'Show content'}
      </button>

      {/* Content preview or full */}
      {showContent ? (
        <div className="relative">
          {ext && (
            <div className="absolute top-2 right-2 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {ext}
            </div>
          )}
          <pre className="text-xs font-mono bg-background rounded-md p-3 overflow-x-auto max-h-64 overflow-y-auto">
            <code>{params.content}</code>
          </pre>
        </div>
      ) : (
        <pre className="text-xs font-mono bg-background rounded-md p-3 overflow-x-auto text-muted-foreground">
          <code>
            {previewLines.join('\n')}
            {hasMore && '\n...'}
          </code>
        </pre>
      )}

      {/* Success indicator */}
      {toolCall.status === 'completed' && (
        <div className="text-xs text-green-500">
          File created successfully
        </div>
      )}
    </div>
  )
}
