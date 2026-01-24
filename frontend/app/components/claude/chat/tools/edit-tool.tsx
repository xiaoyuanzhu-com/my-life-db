import { useState } from 'react'
import { MessageDot } from '../message-dot'
import type { ToolCall, EditToolParams } from '~/types/claude'

interface EditToolViewProps {
  toolCall: ToolCall
}

const MAX_OLD_LINES = 5
const MAX_NEW_LINES = 5

export function EditToolView({ toolCall }: EditToolViewProps) {
  const params = toolCall.parameters as EditToolParams
  const [expanded, setExpanded] = useState(false)

  // Split into lines for unified diff view
  const oldLines = params.old_string.split('\n')
  const newLines = params.new_string.split('\n')

  // Check if truncation is needed
  const isTruncated = oldLines.length > MAX_OLD_LINES || newLines.length > MAX_NEW_LINES

  // Get lines to display
  const displayOldLines = expanded ? oldLines : oldLines.slice(0, MAX_OLD_LINES)
  const displayNewLines = expanded ? newLines : newLines.slice(0, MAX_NEW_LINES)

  // No need to calculate hidden count - using simple "Show more/less" pattern

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
        <div
          className={expanded && isTruncated ? 'overflow-y-auto' : ''}
          style={expanded && isTruncated ? { maxHeight: '60vh' } : {}}
        >
          {/* Deleted lines */}
          {displayOldLines.map((line, i) => (
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
          {displayNewLines.map((line, i) => (
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

        {/* Expand/Collapse button */}
        {isTruncated && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full py-1.5 text-[12px] cursor-pointer hover:opacity-80 transition-opacity"
            style={{
              backgroundColor: 'var(--claude-bg-secondary)',
              color: 'var(--claude-text-secondary)',
              borderTop: '1px solid var(--claude-border-light)',
            }}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
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
