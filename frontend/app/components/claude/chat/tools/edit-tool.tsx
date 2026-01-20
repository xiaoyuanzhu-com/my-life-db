import type { ToolCall, EditToolParams } from '~/types/claude'

interface EditToolViewProps {
  toolCall: ToolCall
}

export function EditToolView({ toolCall }: EditToolViewProps) {
  const params = toolCall.parameters as EditToolParams

  // Split into lines for unified diff view
  const oldLines = params.old_string.split('\n')
  const newLines = params.new_string.split('\n')

  return (
    <div>
      {/* File path header */}
      <div
        className="font-mono text-[13px] font-medium mb-3 pb-2"
        style={{
          color: 'var(--claude-text-secondary)',
          borderBottom: '1px solid var(--claude-border-light)',
        }}
      >
        {params.file_path}
        {params.replace_all && (
          <span className="ml-2 opacity-70 font-normal">(replace all)</span>
        )}
      </div>

      {/* Unified diff view */}
      <div
        className="rounded-md overflow-hidden"
        style={{ border: '1px solid var(--claude-border-light)' }}
      >
        {/* Deleted lines */}
        {oldLines.map((line, i) => (
          <div
            key={`del-${i}`}
            className="font-mono text-[13px] leading-[1.5] flex"
            style={{
              backgroundColor: 'var(--claude-diff-del-bg)',
              color: 'var(--claude-diff-del-fg)',
            }}
          >
            <span className="inline-block px-3 select-none">-</span>
            <span className="flex-1 pr-3 whitespace-pre-wrap break-all">{line}</span>
          </div>
        ))}

        {/* Added lines */}
        {newLines.map((line, i) => (
          <div
            key={`add-${i}`}
            className="font-mono text-[13px] leading-[1.5] flex"
            style={{
              backgroundColor: 'var(--claude-diff-add-bg)',
              color: 'var(--claude-diff-add-fg)',
            }}
          >
            <span className="inline-block px-3 select-none">+</span>
            <span className="flex-1 pr-3 whitespace-pre-wrap break-all">{line}</span>
          </div>
        ))}
      </div>

      {/* Error */}
      {toolCall.error && (
        <div
          className="font-mono text-[13px] mt-2"
          style={{ color: 'var(--claude-status-alert)' }}
        >
          {toolCall.error}
        </div>
      )}
    </div>
  )
}
