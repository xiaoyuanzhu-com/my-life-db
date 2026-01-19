import { Search, ExternalLink, Globe } from 'lucide-react'
import type { ToolCall, WebSearchToolParams, WebSearchToolResult } from '~/types/claude'

interface WebSearchToolViewProps {
  toolCall: ToolCall
}

export function WebSearchToolView({ toolCall }: WebSearchToolViewProps) {
  const params = toolCall.parameters as WebSearchToolParams
  const result = toolCall.result as WebSearchToolResult | undefined

  return (
    <div className="space-y-2">
      {/* Query */}
      <div className="flex items-center gap-2">
        <Search className="h-4 w-4 text-orange-500" />
        <span className="text-sm font-medium">{params.query}</span>
      </div>

      {/* Filters */}
      {(params.allowed_domains?.length || params.blocked_domains?.length) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {params.allowed_domains?.length && (
            <span>Only: {params.allowed_domains.join(', ')}</span>
          )}
          {params.blocked_domains?.length && (
            <span>Exclude: {params.blocked_domains.join(', ')}</span>
          )}
        </div>
      )}

      {/* Results */}
      {result?.results && result.results.length > 0 ? (
        <div className="rounded-md border border-border overflow-hidden">
          {result.results.map((item, index) => (
            <a
              key={index}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block px-3 py-2 hover:bg-muted/50 border-b border-border last:border-b-0"
            >
              <div className="flex items-start gap-2">
                <Globe className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-primary flex items-center gap-1">
                    <span className="truncate">{item.title}</span>
                    <ExternalLink className="h-3 w-3 flex-shrink-0" />
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {item.url}
                  </div>
                  {item.snippet && (
                    <p className="text-xs text-foreground/80 mt-1 line-clamp-2">
                      {item.snippet}
                    </p>
                  )}
                </div>
              </div>
            </a>
          ))}
        </div>
      ) : toolCall.status === 'completed' ? (
        <div className="text-xs text-muted-foreground">
          No results found
        </div>
      ) : null}
    </div>
  )
}
