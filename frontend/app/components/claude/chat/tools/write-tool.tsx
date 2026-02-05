import { useState, useEffect } from 'react'
import { MessageDot } from '../message-dot'
import { highlightCode } from '~/lib/markdown'
import type { ToolCall, WriteToolParams } from '~/types/claude'

interface WriteToolViewProps {
  toolCall: ToolCall
}

const MAX_LINES = 10

// Map file extensions to Shiki language identifiers
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    md: 'markdown',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    dockerfile: 'dockerfile',
    toml: 'toml',
    ini: 'ini',
    vue: 'vue',
    svelte: 'svelte',
  }
  return langMap[ext] || 'text'
}

export function WriteToolView({ toolCall }: WriteToolViewProps) {
  const params = toolCall.parameters as WriteToolParams
  const [expanded, setExpanded] = useState(false)
  const [html, setHtml] = useState('')

  const lines = params.content.split('\n')
  const isTruncated = lines.length > MAX_LINES
  const displayContent = expanded ? params.content : lines.slice(0, MAX_LINES).join('\n')
  const lang = getLanguageFromPath(params.file_path)

  // Highlight content with Shiki
  useEffect(() => {
    let cancelled = false

    highlightCode(displayContent, lang).then((highlighted) => {
      if (cancelled) return
      setHtml(highlighted)
    })

    return () => {
      cancelled = true
    }
  }, [displayContent, lang])

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: Status-colored bullet + "Write" + file path */}
      <div className="flex items-start gap-2 mb-3">
        <MessageDot status={toolCall.status} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Write
          </span>
          <span className="ml-2 break-all" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.file_path}
          </span>
        </div>
      </div>

      {/* Content preview with syntax highlighting */}
      {!toolCall.error && (
        <div
          className="rounded-md overflow-hidden"
          style={{ border: '1px solid var(--claude-border-light)' }}
        >
          <div
            className={expanded && isTruncated ? 'overflow-y-auto' : ''}
            style={expanded && isTruncated ? { maxHeight: '60vh' } : {}}
          >
            <div
              className="p-3 text-[12px] [&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:!bg-transparent [&_code]:!bg-transparent"
              style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
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
              {expanded ? 'Show less' : `Show more (${lines.length} lines)`}
            </button>
          )}
        </div>
      )}

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
