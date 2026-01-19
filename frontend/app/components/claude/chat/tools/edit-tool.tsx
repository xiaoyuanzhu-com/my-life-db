import { FileEdit, Minus, Plus } from 'lucide-react'
import type { ToolCall, EditToolParams } from '~/types/claude'

interface EditToolViewProps {
  toolCall: ToolCall
}

export function EditToolView({ toolCall }: EditToolViewProps) {
  const params = toolCall.parameters as EditToolParams

  // Extract filename
  const filename = params.file_path.split('/').pop() || params.file_path

  return (
    <div className="space-y-2">
      {/* File path */}
      <div className="flex items-center gap-2 text-sm">
        <FileEdit className="h-4 w-4 text-yellow-500" />
        <span className="font-mono text-xs truncate">{params.file_path}</span>
        {params.replace_all && (
          <span className="text-xs text-muted-foreground">(replace all)</span>
        )}
      </div>

      {/* Diff view */}
      <div className="rounded-md border border-border overflow-hidden">
        {/* Old string (removed) */}
        <div className="bg-red-500/10 border-b border-border">
          <div className="flex items-center gap-2 px-3 py-1 text-xs text-red-500">
            <Minus className="h-3 w-3" />
            <span>Removed</span>
          </div>
          <pre className="px-3 py-2 text-xs font-mono overflow-x-auto bg-red-500/5">
            <code className="text-red-600 dark:text-red-400">
              {params.old_string}
            </code>
          </pre>
        </div>

        {/* New string (added) */}
        <div className="bg-green-500/10">
          <div className="flex items-center gap-2 px-3 py-1 text-xs text-green-500">
            <Plus className="h-3 w-3" />
            <span>Added</span>
          </div>
          <pre className="px-3 py-2 text-xs font-mono overflow-x-auto bg-green-500/5">
            <code className="text-green-600 dark:text-green-400">
              {params.new_string}
            </code>
          </pre>
        </div>
      </div>

      {/* Success indicator */}
      {toolCall.status === 'completed' && (
        <div className="text-xs text-green-500">
          Edit applied successfully
        </div>
      )}

      {/* Error */}
      {toolCall.error && (
        <div className="text-xs text-red-500">
          {toolCall.error}
        </div>
      )}
    </div>
  )
}
