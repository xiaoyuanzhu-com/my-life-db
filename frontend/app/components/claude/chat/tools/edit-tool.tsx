import { MessageDot } from '../message-dot'
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
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "Edit" + file path */}
      <div className="flex items-start gap-2 mb-3">
        <MessageDot status={toolCall.status} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Edit
          </span>
          <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.file_path}
            {params.replace_all && (
              <span className="ml-2 opacity-70">(replace all)</span>
            )}
          </span>
        </div>
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
