import type { ToolCall, GlobToolParams, GlobToolResult } from '~/types/claude'

interface GlobToolViewProps {
  toolCall: ToolCall
}

export function GlobToolView({ toolCall }: GlobToolViewProps) {
  const params = toolCall.parameters as GlobToolParams
  const result = toolCall.result as GlobToolResult | string[] | undefined

  const files = Array.isArray(result) ? result : result?.files || []

  return (
    <div>
      {/* Pattern */}
      <div
        className="font-mono text-[13px] mb-2"
        style={{ color: 'var(--claude-text-secondary)' }}
      >
        {params.pattern}
        {params.path && <span className="opacity-70 ml-2">in {params.path}</span>}
      </div>

      {/* File list */}
      {files.length > 0 ? (
        <div
          className="font-mono text-[13px] rounded-md p-3"
          style={{
            backgroundColor: 'var(--claude-bg-code-block)',
            color: 'var(--claude-text-primary)',
          }}
        >
          {files.map((file, i) => (
            <div key={i} className="py-0.5">
              {file}
            </div>
          ))}
        </div>
      ) : (
        <div
          className="font-mono text-[13px]"
          style={{ color: 'var(--claude-text-tertiary)' }}
        >
          No files found
        </div>
      )}

      {files.length > 0 && (
        <div
          className="font-mono text-[13px] mt-1"
          style={{ color: 'var(--claude-text-tertiary)' }}
        >
          {files.length} file{files.length !== 1 ? 's' : ''} found
        </div>
      )}
    </div>
  )
}
