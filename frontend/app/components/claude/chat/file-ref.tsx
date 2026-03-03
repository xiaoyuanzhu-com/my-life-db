import { FileText } from 'lucide-react'
import { Link } from 'react-router'

interface FileRefProps {
  path: string
  /** Library-relative path to link to. If set, renders as a clickable link. */
  libraryPath?: string | null
  /** Whether this is a directory (uses ?dir= instead of ?open=). */
  isDirectory?: boolean
  showIcon?: boolean
  className?: string
}

/**
 * FileRef renders a file path as a styled element.
 * Shows just the filename with the full path on hover.
 * When libraryPath is set, renders as a clickable link to the library page.
 */
export function FileRef({ path, libraryPath, isDirectory, showIcon = true, className = '' }: FileRefProps) {
  const filename = path.split('/').pop() || path

  const inner = (
    <>
      {showIcon && <FileText className="h-3 w-3 flex-shrink-0" />}
      <span className="truncate max-w-[200px]">{filename}</span>
    </>
  )

  if (libraryPath != null) {
    const param = isDirectory ? 'dir' : 'open'
    const to = `/library?${param}=${encodeURIComponent(libraryPath)}`

    return (
      <Link
        to={to}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[13px] cursor-pointer hover:underline ${className}`}
        style={{
          backgroundColor: 'var(--claude-bg-code-block)',
          color: 'var(--claude-accent, var(--claude-text-secondary))',
        }}
        title={path}
      >
        {inner}
      </Link>
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[13px] cursor-default ${className}`}
      style={{
        backgroundColor: 'var(--claude-bg-code-block)',
        color: 'var(--claude-text-secondary)',
      }}
      title={path}
    >
      {inner}
    </span>
  )
}

/**
 * Parses text containing special tags and file paths, returning React elements.
 * Handles:
 * - <ide_opened_file>...</ide_opened_file> tags
 * - <ide_selection>...</ide_selection> tags
 * - Absolute file paths (starting with /)
 */
export function parseFileReferences(text: string): (string | JSX.Element)[] {
  const result: (string | JSX.Element)[] = []

  // Pattern for IDE context tags and their contents
  const tagPattern = /<(ide_opened_file|ide_selection)>([\s\S]*?)<\/\1>/g

  let lastIndex = 0
  let match: RegExpExecArray | null
  let keyIndex = 0

  while ((match = tagPattern.exec(text)) !== null) {
    // Add text before the tag
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index))
    }

    const tagType = match[1]
    const tagContent = match[2]

    // Extract file path from the tag content
    // Pattern: "The user opened the file /path/to/file in the IDE"
    const pathMatch = tagContent.match(/(?:opened the file |file )([^\s]+(?:\.[a-zA-Z0-9]+)?)/i)

    if (pathMatch) {
      const filePath = pathMatch[1]
      result.push(
        <span
          key={`tag-${keyIndex++}`}
          className="inline-flex items-center gap-1 text-[13px] italic"
          style={{ color: 'var(--claude-text-secondary)' }}
        >
          <span className="opacity-60">
            {tagType === 'ide_opened_file' ? 'Viewing: ' : 'Selected: '}
          </span>
          <FileRef path={filePath} showIcon={true} />
        </span>
      )
    } else {
      // Couldn't extract path, show abbreviated version
      const abbreviated = tagContent.length > 50
        ? tagContent.slice(0, 50) + '...'
        : tagContent
      result.push(
        <span
          key={`tag-${keyIndex++}`}
          className="text-[13px] italic"
          style={{ color: 'var(--claude-text-secondary)' }}
          title={tagContent}
        >
          [{tagType}: {abbreviated}]
        </span>
      )
    }

    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex))
  }

  return result.length > 0 ? result : [text]
}

/**
 * Splits user message content into contextual parts (IDE tags) and actual message.
 * Returns separate elements for cleaner rendering.
 */
export function splitMessageContent(text: string): { context: JSX.Element | null; message: string } {
  const tagPattern = /<(ide_opened_file|ide_selection)>([\s\S]*?)<\/\1>/g
  const contexts: JSX.Element[] = []
  let messageText = text
  let keyIndex = 0

  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(text)) !== null) {
    const tagType = match[1]
    const tagContent = match[2]

    // Extract file path from the tag content
    const pathMatch = tagContent.match(/(?:opened the file |file )([^\s]+(?:\.[a-zA-Z0-9]+)?)/i)

    if (pathMatch) {
      const filePath = pathMatch[1]
      contexts.push(
        <span
          key={`ctx-${keyIndex++}`}
          className="inline-flex items-center gap-1"
        >
          <span className="opacity-60 text-[12px]">
            {tagType === 'ide_opened_file' ? 'Viewing' : 'Selected'}:
          </span>
          <FileRef path={filePath} showIcon={true} />
        </span>
      )
    }

    // Remove the tag from message text
    messageText = messageText.replace(match[0], '').trim()
  }

  return {
    context: contexts.length > 0 ? (
      <div
        className="flex flex-wrap items-center gap-2 mb-2 text-[13px]"
        style={{ color: 'var(--claude-text-secondary)' }}
      >
        {contexts}
      </div>
    ) : null,
    message: messageText,
  }
}
