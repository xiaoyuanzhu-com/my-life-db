import type { ToolCall, GrepToolParams, GrepToolResult } from '~/types/claude'

interface GrepToolViewProps {
  toolCall: ToolCall
}

export function GrepToolView({ toolCall }: GrepToolViewProps) {
  const params = toolCall.parameters as GrepToolParams
  const result = toolCall.result as GrepToolResult | string | undefined

  const files = typeof result === 'object' && result?.files ? result.files :
                typeof result === 'string' ? [result] : []

  return (
    <div>
      {/* Pattern */}
      <div
        className="font-mono text-[13px] mb-2"
        style={{ color: 'var(--claude-text-secondary)' }}
      >
        /{params.pattern}/
        {params.glob && <span className="opacity-70 ml-2">in {params.glob}</span>}
        {params.type && <span className="opacity-70 ml-2">type:{params.type}</span>}
      </div>

      {/* Results */}
      {files.length > 0 ? (
        <div
          className="font-mono text-[13px] rounded-md p-3 max-h-64 overflow-y-auto"
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
          No matches found
        </div>
      )}

      {files.length > 0 && (
        <div
          className="font-mono text-[13px] mt-1"
          style={{ color: 'var(--claude-text-tertiary)' }}
        >
          {files.length} match{files.length !== 1 ? 'es' : ''} found
        </div>
      )}
    </div>
  )
}
