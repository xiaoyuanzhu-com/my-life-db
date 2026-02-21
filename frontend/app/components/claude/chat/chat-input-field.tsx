import { useRef, useEffect, useState, KeyboardEvent } from 'react'
import { ArrowUp, Paperclip, Square } from 'lucide-react'
import { cn } from '~/lib/utils'
import { useMessageInputKeyboard } from '~/hooks/use-message-input-keyboard'
import { FolderPicker } from './folder-picker'
import { SlashCommandPopover } from './slash-command-popover'
import { FileTagPopover } from './file-tag-popover'
import { PermissionModeSelector, type PermissionMode } from './permission-mode-selector'
import { ContextUsageIndicator, type ContextUsage } from './context-usage-indicator'
import { filterCommands } from './hooks'
import { useFileTag, useFilteredFiles } from './hooks/use-file-tag'
import type { SlashCommand } from './slash-commands'

interface ChatInputFieldProps {
  /** Current input content */
  content: string
  /** Update input content */
  onChange: (content: string) => void
  /** Called when user submits the message */
  onSend: () => void
  /** Called when user wants to send a slash command directly */
  onSlashCommand?: (command: string) => void
  /** Called when user wants to interrupt */
  onInterrupt?: () => void
  /** Whether Claude is currently working */
  isWorking?: boolean
  /** Whether input is disabled */
  disabled?: boolean
  /** Placeholder text */
  placeholder?: string
  /** Whether there's a pending permission (blocks sending) */
  hasPermission?: boolean
  /** Working directory to display */
  workingDir?: string
  /** Callback when working directory changes */
  onWorkingDirChange?: (path: string) => void
  /** Available slash commands */
  slashCommands?: SlashCommand[]
  /** Current permission mode */
  permissionMode?: PermissionMode
  /** Callback when permission mode changes */
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Context window usage data */
  contextUsage?: ContextUsage | null
  /** Callback when user clicks context usage indicator to trigger compact */
  onCompact?: () => void
}

export function ChatInputField({
  content,
  onChange,
  onSend,
  onSlashCommand,
  onInterrupt,
  isWorking = false,
  disabled = false,
  placeholder = 'Reply...',
  hasPermission = false,
  workingDir,
  onWorkingDirChange,
  slashCommands = [],
  permissionMode = 'default',
  onPermissionModeChange,
  contextUsage,
  onCompact,
}: ChatInputFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const keyboard = useMessageInputKeyboard()
  const [slashPopoverOpen, setSlashPopoverOpen] = useState(false)
  const [buttonPopoverOpen, setButtonPopoverOpen] = useState(false)
  const [fileTagPopoverOpen, setFileTagPopoverOpen] = useState(false)
  const [cursorPos, setCursorPos] = useState(0)
  const [fileTagFocusIndex, setFileTagFocusIndex] = useState(0)

  // File tagging state
  const { files: allFiles, loading: filesLoading } = useFileTag(workingDir)

  // Unified input mode detection - returns exactly one mode
  // This prevents conflicting states where both slash and file tag could be active
  type InputMode =
    | { type: 'slash'; triggerIndex: number; query: string; textBefore: string; textAfter: string }
    | { type: 'fileTag'; triggerIndex: number; query: string; textBefore: string; textAfter: string }
    | { type: 'none' }

  const getInputModeAtCursor = (): InputMode => {
    // First, find the start of the current token (go backwards until whitespace)
    let tokenStart = cursorPos
    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = content[i]
      if (char === ' ' || char === '\n' || char === '\t') {
        tokenStart = i + 1
        break
      }
      if (i === 0) {
        tokenStart = 0
      }
    }

    // Check if token starts with a trigger character
    const firstChar = content[tokenStart]
    if (firstChar !== '/' && firstChar !== '@') {
      return { type: 'none' }
    }

    // Find end of the token (next whitespace or end of string)
    let tokenEnd = content.length
    for (let i = cursorPos; i < content.length; i++) {
      if (content[i] === ' ' || content[i] === '\n' || content[i] === '\t') {
        tokenEnd = i
        break
      }
    }

    const result = {
      triggerIndex: tokenStart,
      query: content.slice(tokenStart + 1, tokenEnd),
      textBefore: content.slice(0, tokenStart),
      textAfter: content.slice(tokenEnd),
    }

    return firstChar === '/'
      ? { type: 'slash', ...result }
      : { type: 'fileTag', ...result }
  }

  const inputMode = getInputModeAtCursor()
  const isSlashMode = inputMode.type === 'slash'
  const isFileTagMode = inputMode.type === 'fileTag'

  // Extract mode-specific data
  const slashQuery = isSlashMode ? inputMode.query : ''
  const textBeforeSlash = isSlashMode ? inputMode.textBefore : ''
  const textAfterSlash = isSlashMode ? inputMode.textAfter : ''

  const fileTagQuery = isFileTagMode ? inputMode.query : ''
  const textBeforeAt = isFileTagMode ? inputMode.textBefore : ''
  const textAfterAt = isFileTagMode ? inputMode.textAfter : ''

  // Filter files based on query
  const filteredFiles = useFilteredFiles(allFiles, fileTagQuery)

  // Keep last valid files to avoid flash during close animation
  const lastFilesRef = useRef<typeof filteredFiles>([])
  if (isFileTagMode) {
    lastFilesRef.current = filteredFiles
  }
  // Use frozen list when popover is closing (prevents flash)
  const displayedFiles = isFileTagMode ? filteredFiles : lastFilesRef.current

  // Effective popover open state: either in slash mode OR opened via button
  const effectivePopoverOpen = (slashPopoverOpen && isSlashMode) || buttonPopoverOpen

  // Keep last valid commands to avoid flash during close animation
  const lastCommandsRef = useRef<SlashCommand[]>([])
  const filteredCommands = buttonPopoverOpen
    ? slashCommands // Show all commands when opened via button
    : isSlashMode
      ? filterCommands(slashCommands, slashQuery)
      : lastCommandsRef.current
  if (isSlashMode || buttonPopoverOpen) {
    lastCommandsRef.current = filteredCommands
  }

  // Update cursor position on selection change
  const handleSelect = () => {
    const pos = textareaRef.current?.selectionStart ?? 0
    setCursorPos(pos)
  }

  // Re-enable popover when entering slash mode (after it was manually closed)
  useEffect(() => {
    if (isSlashMode && !slashPopoverOpen) {
      setSlashPopoverOpen(true)
    }
  }, [isSlashMode, slashPopoverOpen])

  // Re-enable file tag popover when entering @ mode
  useEffect(() => {
    if (isFileTagMode && !fileTagPopoverOpen) {
      setFileTagPopoverOpen(true)
    }
  }, [isFileTagMode, fileTagPopoverOpen])

  // Reset focus index when filtered files change
  useEffect(() => {
    setFileTagFocusIndex(0)
  }, [filteredFiles])

  // Effective file tag popover state
  const effectiveFileTagPopoverOpen = fileTagPopoverOpen && isFileTagMode

  // Handle slash command selection - send command directly and keep surrounding text
  const handleSlashSelect = (cmd: SlashCommand) => {
    // Send the slash command
    if (onSlashCommand) {
      onSlashCommand(`/${cmd.name}`)
    }

    // If opened via button, just close popover (no content modification needed)
    if (buttonPopoverOpen) {
      setButtonPopoverOpen(false)
      textareaRef.current?.focus()
      return
    }

    // Keep text before and after the slash command
    const newContent = textBeforeSlash + textAfterSlash
    onChange(newContent)
    // Set cursor to end of textBeforeSlash
    requestAnimationFrame(() => {
      const pos = textBeforeSlash.length
      textareaRef.current?.setSelectionRange(pos, pos)
      setCursorPos(pos)
    })
    setSlashPopoverOpen(false)
    textareaRef.current?.focus()
  }

  // Handle file tag selection - insert file path and keep surrounding text
  const handleFileTagSelect = (file: { path: string }) => {
    // Replace @query with the file path + space to exit tag mode
    const newContent = textBeforeAt + '@' + file.path + ' ' + textAfterAt
    onChange(newContent)
    // Set cursor to after the space
    requestAnimationFrame(() => {
      const pos = textBeforeAt.length + 1 + file.path.length + 1
      textareaRef.current?.setSelectionRange(pos, pos)
      setCursorPos(pos)
    })
    setFileTagPopoverOpen(false)
    textareaRef.current?.focus()
  }

  // Handle "/" button click - toggle the command list
  const handleSlashButtonClick = () => {
    setButtonPopoverOpen((prev) => !prev)
  }

  // Handle content change and update cursor position
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
    setCursorPos(e.target.selectionStart)
    // Close button popover when user starts typing
    if (buttonPopoverOpen) {
      setButtonPopoverOpen(false)
    }
  }

  // Handle textarea click - close button popover
  const handleTextareaClick = () => {
    if (buttonPopoverOpen) {
      setButtonPopoverOpen(false)
    }
  }

  // Auto-resize textarea as content grows
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [content])

  // Handle Esc key for interrupt (when working and no permission pending)
  useEffect(() => {
    if (!isWorking || hasPermission || !onInterrupt) return

    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onInterrupt()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isWorking, hasPermission, onInterrupt])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Close popovers on Escape
    if (e.key === 'Escape' && (effectivePopoverOpen || effectiveFileTagPopoverOpen)) {
      e.preventDefault()
      setSlashPopoverOpen(false)
      setButtonPopoverOpen(false)
      setFileTagPopoverOpen(false)
      return
    }

    // File tag popover keyboard navigation
    if (effectiveFileTagPopoverOpen && displayedFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFileTagFocusIndex((prev) => (prev + 1) % displayedFiles.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFileTagFocusIndex((prev) => (prev - 1 + displayedFiles.length) % displayedFiles.length)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleFileTagSelect(displayedFiles[fileTagFocusIndex])
        return
      }
    }

    // Send on Enter — guarded by IME composition + mobile detection
    // Desktop: Enter sends, Shift+Enter inserts newline
    // Mobile:  Return always inserts newline, send via button only
    if (!hasPermission && keyboard.shouldSend(e)) {
      e.preventDefault()
      onSend()
    }
  }

  const handleAttachClick = () => {
    // Insert "@" at cursor position to trigger file tag popover
    const before = content.slice(0, cursorPos)
    const after = content.slice(cursorPos)
    const newContent = before + '@' + after
    onChange(newContent)
    // Move cursor after the "@"
    requestAnimationFrame(() => {
      const pos = cursorPos + 1
      textareaRef.current?.setSelectionRange(pos, pos)
      setCursorPos(pos)
      textareaRef.current?.focus()
    })
  }

  const canSend = content.trim() && !disabled && !hasPermission

  return (
    <div ref={containerRef} className="px-3 py-2 relative">
      {/* Slash command popover */}
      <SlashCommandPopover
        open={effectivePopoverOpen}
        onOpenChange={(open) => {
          setSlashPopoverOpen(open)
          if (!open) setButtonPopoverOpen(false)
        }}
        commands={filteredCommands}
        onSelect={handleSlashSelect}
        anchorRef={containerRef}
      />

      {/* File tag popover */}
      <FileTagPopover
        open={effectiveFileTagPopoverOpen}
        onOpenChange={setFileTagPopoverOpen}
        files={displayedFiles}
        loading={filesLoading}
        onSelect={handleFileTagSelect}
        anchorRef={containerRef}
        focusIndex={fileTagFocusIndex}
      />

      {/* Text input */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={handleChange}
        onClick={handleTextareaClick}
        onSelect={handleSelect}
        onKeyDown={handleKeyDown}
        onCompositionStart={keyboard.onCompositionStart}
        onCompositionEnd={keyboard.onCompositionEnd}
        enterKeyHint={keyboard.enterKeyHint}
        placeholder={hasPermission ? 'Waiting for permission...' : placeholder}
        disabled={disabled || hasPermission}
        rows={1}
        className={cn(
          'w-full resize-none',
          'text-[15px] text-foreground',
          'placeholder:text-muted-foreground',
          'bg-transparent border-none outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'min-h-[24px]'
        )}
      />

      {/* Actions row */}
      <div className="flex items-center justify-between mt-2">
        {/* Left side - working dir and permission mode */}
        <div className="flex items-center gap-1.5 sm:gap-3">
          {(workingDir || onWorkingDirChange) && (
            <FolderPicker
              value={workingDir || ''}
              onChange={onWorkingDirChange}
              disabled={disabled || hasPermission}
              readOnly={!onWorkingDirChange}
            />
          )}
          {onPermissionModeChange && (
            <PermissionModeSelector
              value={permissionMode}
              onChange={onPermissionModeChange}
              disabled={disabled || hasPermission}
              showLabel
            />
          )}
          {contextUsage && (
            <ContextUsageIndicator
              usage={contextUsage}
              onCompact={onCompact}
              disabled={disabled || hasPermission}
            />
          )}
        </div>

        {/* Right side - attach, slash button and submit/stop */}
        <div className="flex items-center gap-1 sm:gap-2">
          {/* Attach file button */}
          <button
            type="button"
            onClick={handleAttachClick}
            disabled={disabled || hasPermission}
            className={cn(
              'h-7 w-7 sm:h-8 sm:w-8 rounded-lg',
              'flex items-center justify-center',
              'text-muted-foreground hover:text-foreground hover:bg-foreground/10',
              'cursor-pointer transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            aria-label="Attach file"
          >
            <Paperclip className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
          </button>

          {/* Slash command button */}
          <button
            type="button"
            onClick={handleSlashButtonClick}
            disabled={disabled || hasPermission}
            className={cn(
              'h-7 w-7 sm:h-8 sm:w-8 rounded-lg',
              'flex items-center justify-center',
              'text-muted-foreground hover:text-foreground hover:bg-foreground/10',
              'cursor-pointer transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'text-xs sm:text-sm font-medium',
              effectivePopoverOpen && 'bg-accent text-foreground'
            )}
            aria-label="Slash commands"
          >
            /
          </button>

          {/* Submit / Stop button */}
          {/* Send button takes priority when there's text input */}
          {isWorking && !hasPermission && !content.trim() ? (
            <button
              type="button"
              onClick={onInterrupt}
              disabled={disabled}
              className={cn(
                'h-8 w-8 sm:h-9 sm:w-9 rounded-lg',
                'bg-muted hover:bg-muted/80 border border-border',
                'flex items-center justify-center',
                'transition-all',
                'disabled:cursor-not-allowed disabled:opacity-50'
              )}
              aria-label="Stop generation (Esc)"
            >
              <Square className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-muted-foreground" fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              className={cn(
                'h-8 w-8 sm:h-9 sm:w-9 rounded-lg',
                'bg-primary hover:bg-primary/80 border border-primary',
                'flex items-center justify-center',
                'transition-all',
                'disabled:cursor-not-allowed',
                !canSend ? 'opacity-40' : 'opacity-100'
              )}
              aria-label="Send message"
            >
              <ArrowUp className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary-foreground" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
