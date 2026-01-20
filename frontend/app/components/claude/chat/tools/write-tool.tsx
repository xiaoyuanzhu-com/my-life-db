import { useState } from 'react'
import type { ToolCall, WriteToolParams } from '~/types/claude'

interface WriteToolViewProps {
  toolCall: ToolCall
}

export function WriteToolView({ toolCall }: WriteToolViewProps) {
  const params = toolCall.parameters as WriteToolParams
  const [showContent, setShowContent] = useState(false)

  const lines = params.content.split('\n')

  return (
    <div>
      {/* File path header with "Created" badge */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className="font-mono text-[13px] font-medium"
          style={{ color: 'var(--claude-text-secondary)' }}
        >
          {params.file_path}
        </span>
        <span
          className="font-mono text-[11px] px-1.5 py-0.5 rounded"
          style={{
            backgroundColor: 'var(--claude-diff-add-bg)',
            color: 'var(--claude-diff-add-fg)',
          }}
        >
          Created
        </span>
      </div>

      {/* Content toggle */}
      <button
        type="button"
        onClick={() => setShowContent(!showContent)}
        className="font-mono text-[13px] mb-2 hover:opacity-80"
        style={{ color: 'var(--claude-text-secondary)' }}
      >
        {showContent ? '▼' : '▶'} {showContent ? 'Hide' : 'Show'} content ({lines.length} lines)
      </button>

      {/* Content */}
      {showContent && (
        <pre
          className="font-mono text-[13px] leading-[1.5] p-3 rounded-md overflow-x-auto max-h-64 overflow-y-auto"
          style={{
            backgroundColor: 'var(--claude-bg-code-block)',
            color: 'var(--claude-text-primary)',
          }}
        >
          <code>{params.content}</code>
        </pre>
      )}
    </div>
  )
}
