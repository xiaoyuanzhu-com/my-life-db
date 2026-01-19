import { Search, File, Hash } from 'lucide-react'
import type { ToolCall, GrepToolParams, GrepToolResult } from '~/types/claude'

interface GrepToolViewProps {
  toolCall: ToolCall
}

export function GrepToolView({ toolCall }: GrepToolViewProps) {
  const params = toolCall.parameters as GrepToolParams
  const result = toolCall.result as GrepToolResult | string | undefined

  // Parse result based on output mode
  const outputMode = params.output_mode || 'files_with_matches'

  return (
    <div className="space-y-2">
      {/* Pattern */}
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <Search className="h-4 w-4 text-cyan-500" />
        <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
          {params.pattern}
        </span>
        {params.glob && (
          <span className="text-xs text-muted-foreground">
            glob: {params.glob}
          </span>
        )}
        {params.type && (
          <span className="text-xs text-muted-foreground">
            type: {params.type}
          </span>
        )}
        {params['-i'] && (
          <span className="text-xs bg-muted px-1 rounded">-i</span>
        )}
      </div>

      {/* Results */}
      {result && (
        <div className="rounded-md bg-background border border-border overflow-hidden">
          {typeof result === 'string' ? (
            // Content mode - show matching lines
            <pre className="p-3 text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto">
              <HighlightedContent content={result} pattern={params.pattern} />
            </pre>
          ) : outputMode === 'files_with_matches' && result.files ? (
            // Files mode
            <>
              <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border">
                Found {result.files.length} file{result.files.length !== 1 ? 's' : ''}
              </div>
              <div className="max-h-48 overflow-y-auto">
                {result.files.slice(0, 20).map((file, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-muted/50"
                  >
                    <File className="h-3 w-3 text-muted-foreground" />
                    <span className="truncate">{file}</span>
                  </div>
                ))}
                {result.files.length > 20 && (
                  <div className="px-3 py-1.5 text-xs text-muted-foreground">
                    ... and {result.files.length - 20} more
                  </div>
                )}
              </div>
            </>
          ) : outputMode === 'count' && result.count !== undefined ? (
            // Count mode
            <div className="flex items-center gap-2 px-3 py-2">
              <Hash className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{result.count}</span>
              <span className="text-xs text-muted-foreground">matches</span>
            </div>
          ) : result.content ? (
            // Fallback to content
            <pre className="p-3 text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto">
              <HighlightedContent content={result.content} pattern={params.pattern} />
            </pre>
          ) : null}
        </div>
      )}

      {/* No results */}
      {toolCall.status === 'completed' && !result && (
        <div className="text-xs text-muted-foreground">
          No matches found
        </div>
      )}
    </div>
  )
}

function HighlightedContent({
  content,
  pattern,
}: {
  content: string
  pattern: string
}) {
  // Simple highlight - escape regex special chars for display
  const lines = content.split('\n')

  return (
    <code>
      {lines.map((line, i) => (
        <div key={i} className="hover:bg-muted/30">
          {line}
        </div>
      ))}
    </code>
  )
}
