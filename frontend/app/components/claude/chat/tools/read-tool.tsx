import { useState, useEffect } from 'react'
import { MessageDot } from '../message-dot'
import { highlightCode } from '~/lib/shiki'
import type { ToolCall, ReadToolParams, ReadToolResult } from '~/types/claude'

interface ReadToolViewProps {
  toolCall: ToolCall
}

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

export function ReadToolView({ toolCall }: ReadToolViewProps) {
  const params = toolCall.parameters as ReadToolParams
  const result = toolCall.result as ReadToolResult | string | undefined
  const [isExpanded, setIsExpanded] = useState(false)
  const [html, setHtml] = useState('')

  // Handle both old format (string) and new format ({ type: "text", file: {...} })
  const content = typeof result === 'string'
    ? result
    : result?.file?.content

  // Get line count from result metadata or count from content
  const lineCount = typeof result === 'object'
    ? (result?.file?.totalLines ?? result?.file?.numLines)
    : undefined

  // Count lines in content for summary
  const actualLineCount = lineCount || (content ? content.split('\n').length : 0)

  // Check if truncated
  const isTruncated = typeof result === 'object' && result?.file?.totalLines && result?.file?.numLines &&
    result.file.numLines < result.file.totalLines

  // Get language for syntax highlighting
  const lang = getLanguageFromPath(params.file_path)

  // Highlight content only when expanded
  useEffect(() => {
    if (!isExpanded || !content) {
      setHtml('')
      return
    }

    let cancelled = false
    highlightCode(content, lang).then((highlighted) => {
      if (!cancelled) setHtml(highlighted)
    })

    return () => {
      cancelled = true
    }
  }, [isExpanded, content, lang])

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Clickable header: Status-colored bullet + "Read" + file path + chevron */}
      <button
        type="button"
        onClick={() => content && setIsExpanded(!isExpanded)}
        className={`flex items-start gap-2 w-full text-left ${content ? 'hover:opacity-80 transition-opacity cursor-pointer' : ''}`}
      >
        <MessageDot status={toolCall.status} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
            Read
          </span>
          <span className="ml-2 break-all" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.file_path}
          </span>
          {/* Chevron indicator for expandable content */}
          {content && (
            <span
              className="ml-2 select-none text-[11px]"
              style={{ color: 'var(--claude-text-tertiary)' }}
            >
              {isExpanded ? '▾' : '▸'}
            </span>
          )}
        </div>
      </button>

      {/* Summary: Read X lines */}
      {actualLineCount > 0 && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
          <span className="select-none">└</span>
          <span>
            Read {actualLineCount} lines
            {isTruncated && (
              <span style={{ color: 'var(--claude-text-tertiary)' }}>
                {' '}(truncated from {result?.file?.totalLines})
              </span>
            )}
          </span>
        </div>
      )}

      {/* Expanded content with syntax highlighting */}
      {isExpanded && content && (
        <div
          className="mt-2 ml-5 rounded-md overflow-hidden"
          style={{ border: '1px solid var(--claude-border-light)' }}
        >
          <div
            className="overflow-y-auto"
            style={{ maxHeight: '60vh' }}
          >
            <div
              className="p-3 text-[12px] [&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:!bg-transparent [&_code]:!bg-transparent"
              style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {toolCall.error && (
        <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-status-alert)' }}>
          <span className="select-none">└</span>
          <span>{toolCall.error}</span>
        </div>
      )}
    </div>
  )
}
