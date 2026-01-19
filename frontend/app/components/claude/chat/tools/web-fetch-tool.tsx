import { Globe, ExternalLink } from 'lucide-react'
import type { ToolCall, WebFetchToolParams } from '~/types/claude'

interface WebFetchToolViewProps {
  toolCall: ToolCall
}

export function WebFetchToolView({ toolCall }: WebFetchToolViewProps) {
  const params = toolCall.parameters as WebFetchToolParams
  const result = toolCall.result as string | undefined

  // Extract domain from URL
  let domain = ''
  try {
    domain = new URL(params.url).hostname
  } catch {
    domain = params.url
  }

  return (
    <div className="space-y-2">
      {/* URL */}
      <div className="flex items-center gap-2">
        <Globe className="h-4 w-4 text-orange-500" />
        <a
          href={params.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono text-primary hover:underline truncate flex items-center gap-1"
        >
          {domain}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {/* Prompt */}
      <div className="text-xs text-muted-foreground">
        <span className="font-medium">Prompt:</span> {params.prompt}
      </div>

      {/* Result */}
      {result && (
        <div className="rounded-md bg-background border border-border p-3 text-sm max-h-64 overflow-y-auto">
          {result}
        </div>
      )}
    </div>
  )
}
