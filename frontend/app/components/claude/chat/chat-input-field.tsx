import { useRef, useEffect, useState, KeyboardEvent } from 'react'
import { ArrowUp, Paperclip, Square } from 'lucide-react'
import { cn } from '~/lib/utils'
import { FolderPicker } from './folder-picker'
import { SlashCommandPopover } from './slash-command-popover'
import { filterCommands } from './hooks'
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
}: ChatInputFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [slashPopoverOpen, setSlashPopoverOpen] = useState(false)
  const [cursorPos, setCursorPos] = useState(0)

  // Find slash command at cursor position
  // Only active if cursor is within "/command" portion (no space after)
  const getSlashCommandAtCursor = () => {
    // Look backwards from cursor to find "/"
    let slashIdx = -1
    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = content[i]
      if (char === '/') {
        slashIdx = i
        break
      }
      // Stop if we hit a space (command ends at space)
      if (char === ' ' || char === '\n') {
        break
      }
    }
    if (slashIdx === -1) return null

    // Check if there's a space between slash and cursor
    const textAfterSlash = content.slice(slashIdx + 1, cursorPos)
    if (textAfterSlash.includes(' ') || textAfterSlash.includes('\n')) {
      return null
    }

    // Find end of command (next space or end of string)
    let endIdx = content.length
    for (let i = cursorPos; i < content.length; i++) {
      if (content[i] === ' ' || content[i] === '\n') {
        endIdx = i
        break
      }
    }

    return {
      slashIndex: slashIdx,
      query: content.slice(slashIdx + 1, endIdx),
      textBefore: content.slice(0, slashIdx),
      textAfter: content.slice(endIdx),
    }
  }

  const slashCommand = getSlashCommandAtCursor()
  const isSlashMode = slashCommand !== null
  const slashQuery = slashCommand?.query ?? ''
  const textBeforeSlash = slashCommand?.textBefore ?? ''
  const textAfterSlash = slashCommand?.textAfter ?? ''

  // Effective popover open state: must be in slash mode AND not manually closed
  const effectivePopoverOpen = slashPopoverOpen && isSlashMode

  // Keep last valid commands to avoid flash during close animation
  const lastCommandsRef = useRef<SlashCommand[]>([])
  const filteredCommands = isSlashMode ? filterCommands(slashCommands, slashQuery) : lastCommandsRef.current
  if (isSlashMode) {
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

  // Handle slash command selection - send command directly and keep surrounding text
  const handleSlashSelect = (cmd: SlashCommand) => {
    // Send the slash command
    if (onSlashCommand) {
      onSlashCommand(`/${cmd.name}`)
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

  // Handle "/" button click - append "/" to trigger slash mode
  const handleSlashButtonClick = () => {
    // Append "/" at the end to trigger slash mode
    const newContent = content + '/'
    onChange(newContent)
    setCursorPos(newContent.length)
    setSlashPopoverOpen(true)
    textareaRef.current?.focus()
  }

  // Handle content change and update cursor position
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
    setCursorPos(e.target.selectionStart)
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
    // Close slash popover on Escape
    if (e.key === 'Escape' && effectivePopoverOpen) {
      e.preventDefault()
      setSlashPopoverOpen(false)
      return
    }
    // Send on Enter (without Shift) - only if no permission pending
    if (e.key === 'Enter' && !e.shiftKey && !hasPermission) {
      e.preventDefault()
      onSend()
    }
    // Shift+Enter: allow default behavior (add newline)
  }

  const handleAttachClick = () => {
    // TODO: Implement file attachment
    console.log('Attach file clicked')
  }

  const canSend = content.trim() && !disabled && !hasPermission

  return (
    <div ref={containerRef} className="px-3 py-2 relative">
      {/* Slash command popover */}
      <SlashCommandPopover
        open={effectivePopoverOpen}
        onOpenChange={setSlashPopoverOpen}
        commands={filteredCommands}
        onSelect={handleSlashSelect}
        anchorRef={containerRef}
      />

      {/* Text input */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={handleChange}
        onSelect={handleSelect}
        onKeyDown={handleKeyDown}
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
        {/* Left side - working dir */}
        <div className="flex items-center gap-3">
          {(workingDir || onWorkingDirChange) && (
            <FolderPicker
              value={workingDir || ''}
              onChange={onWorkingDirChange}
              disabled={disabled || hasPermission}
              readOnly={!onWorkingDirChange}
            />
          )}
        </div>

        {/* Right side - attach, slash button and submit/stop */}
        <div className="flex items-center gap-2">
          {/* Attach file button */}
          <button
            type="button"
            onClick={handleAttachClick}
            disabled={disabled || hasPermission}
            className={cn(
              'p-2 rounded-lg',
              'text-muted-foreground hover:text-foreground hover:bg-muted',
              'cursor-pointer transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            aria-label="Attach file"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>

          {/* Slash command button */}
          <button
            type="button"
            onClick={handleSlashButtonClick}
            disabled={disabled || hasPermission}
            className={cn(
              'p-2 rounded-lg',
              'text-muted-foreground hover:text-foreground hover:bg-muted',
              'cursor-pointer transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'text-sm font-medium leading-none',
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
                'h-9 w-9 rounded-lg',
                'bg-muted hover:bg-muted/80 border border-border',
                'flex items-center justify-center',
                'transition-all',
                'disabled:cursor-not-allowed disabled:opacity-50'
              )}
              aria-label="Stop generation (Esc)"
            >
              <Square className="h-3.5 w-3.5 text-muted-foreground" fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              className={cn(
                'h-9 w-9 rounded-lg',
                'bg-primary hover:bg-primary/80 border border-primary',
                'flex items-center justify-center',
                'transition-all',
                'disabled:cursor-not-allowed',
                !canSend ? 'opacity-40' : 'opacity-100'
              )}
              aria-label="Send message"
            >
              <ArrowUp className="h-4 w-4 text-primary-foreground" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
