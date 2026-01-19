import { FolderSearch, File, Folder } from 'lucide-react'
import type { ToolCall, GlobToolParams, GlobToolResult } from '~/types/claude'

interface GlobToolViewProps {
  toolCall: ToolCall
}

export function GlobToolView({ toolCall }: GlobToolViewProps) {
  const params = toolCall.parameters as GlobToolParams
  const result = toolCall.result as GlobToolResult | string[] | undefined

  // Normalize result
  const files = Array.isArray(result) ? result : result?.files || []
  const count = Array.isArray(result) ? result.length : result?.count || files.length

  return (
    <div className="space-y-2">
      {/* Pattern */}
      <div className="flex items-center gap-2 text-sm">
        <FolderSearch className="h-4 w-4 text-cyan-500" />
        <span className="font-mono text-xs">{params.pattern}</span>
        {params.path && (
          <span className="text-xs text-muted-foreground">in {params.path}</span>
        )}
      </div>

      {/* Results */}
      {files.length > 0 ? (
        <div className="rounded-md bg-background border border-border">
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border">
            Found {count} file{count !== 1 ? 's' : ''}
          </div>
          <div className="max-h-48 overflow-y-auto">
            {files.slice(0, 20).map((file, index) => (
              <div
                key={index}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-muted/50"
              >
                {file.endsWith('/') ? (
                  <Folder className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <File className="h-3 w-3 text-muted-foreground" />
                )}
                <span className="truncate">{file}</span>
              </div>
            ))}
            {files.length > 20 && (
              <div className="px-3 py-1.5 text-xs text-muted-foreground">
                ... and {files.length - 20} more
              </div>
            )}
          </div>
        </div>
      ) : toolCall.status === 'completed' ? (
        <div className="text-xs text-muted-foreground">
          No files found matching pattern
        </div>
      ) : null}
    </div>
  )
}
