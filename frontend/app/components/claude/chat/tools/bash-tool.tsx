import { Terminal, Clock, AlertCircle, CheckCircle } from 'lucide-react'
import { cn } from '~/lib/utils'
import type { ToolCall, BashToolParams, BashToolResult } from '~/types/claude'

interface BashToolViewProps {
  toolCall: ToolCall
}

export function BashToolView({ toolCall }: BashToolViewProps) {
  const params = (toolCall.parameters || {}) as BashToolParams
  const result = toolCall.result as BashToolResult | string | undefined

  // Parse result
  const output = typeof result === 'string' ? result : result?.output
  const exitCode = typeof result === 'object' ? result?.exitCode : undefined
  const duration = typeof result === 'object' ? result?.duration : toolCall.duration

  return (
    <div className="space-y-2">
      {/* Command header */}
      <div className="flex items-center gap-2 flex-wrap">
        <Terminal className="h-4 w-4 text-purple-500" />
        {params?.description && (
          <span className="text-xs text-muted-foreground">{params.description}</span>
        )}
        {params?.run_in_background && (
          <span className="text-xs bg-muted px-1.5 py-0.5 rounded">background</span>
        )}
      </div>

      {/* Command */}
      <div className="rounded-md bg-zinc-900 p-3 font-mono text-sm">
        <div className="flex items-start gap-2">
          <span className="text-green-400 select-none">$</span>
          <pre className="text-zinc-100 overflow-x-auto whitespace-pre-wrap break-all">
            {params?.command || 'No command'}
          </pre>
        </div>
      </div>

      {/* Output */}
      {output && (
        <div className="rounded-md bg-zinc-900 p-3 font-mono text-xs max-h-48 overflow-auto">
          <pre className="text-zinc-300 whitespace-pre-wrap break-all">
            {output}
          </pre>
        </div>
      )}

      {/* Status bar */}
      {(exitCode !== undefined || duration) && (
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {exitCode !== undefined && (
            <div className="flex items-center gap-1">
              {exitCode === 0 ? (
                <CheckCircle className="h-3 w-3 text-green-500" />
              ) : (
                <AlertCircle className="h-3 w-3 text-red-500" />
              )}
              <span className={cn(exitCode === 0 ? 'text-green-500' : 'text-red-500')}>
                exit {exitCode}
              </span>
            </div>
          )}
          {duration && (
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              <span>{(duration / 1000).toFixed(2)}s</span>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {toolCall.error && (
        <div className="text-xs text-red-500 flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {toolCall.error}
        </div>
      )}
    </div>
  )
}
