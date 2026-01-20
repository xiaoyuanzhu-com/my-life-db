import type { ToolCall, ReadToolParams, ReadToolResult } from '~/types/claude'

interface ReadToolViewProps {
  toolCall: ToolCall
}

export function ReadToolView({ toolCall }: ReadToolViewProps) {
  const params = toolCall.parameters as ReadToolParams
  const result = toolCall.result as ReadToolResult | string | undefined

  const content = typeof result === 'string' ? result : result?.content

  return (
    <div>
      {/* File path header - monospace, gray */}
      <div
        className="font-mono text-[13px] font-medium mb-2"
        style={{ color: 'var(--claude-text-secondary)' }}
      >
        {params.file_path}
        {params.offset !== undefined && (
          <span className="ml-2 font-normal opacity-70">
            (lines {params.offset}–{params.offset + (params.limit || 2000)})
          </span>
        )}
      </div>

      {/* Content with line numbers */}
      {content && (
        <pre
          className="font-mono text-[13px] leading-[1.5] p-3 rounded-md overflow-x-auto"
          style={{
            backgroundColor: 'var(--claude-bg-code-block)',
            color: 'var(--claude-text-primary)',
          }}
        >
          <code>{content}</code>
        </pre>
      )}

      {typeof result === 'object' && result?.truncated && (
        <div
          className="font-mono text-[13px] mt-1"
          style={{ color: 'var(--claude-text-tertiary)' }}
        >
          Content truncated ({result.lineCount} total lines)
        </div>
      )}
    </div>
  )
}
