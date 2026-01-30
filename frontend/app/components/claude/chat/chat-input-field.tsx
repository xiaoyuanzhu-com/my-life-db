import { useRef, useEffect, useState, KeyboardEvent } from 'react'
import { ArrowUp, Image, Square } from 'lucide-react'
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

  // Check if input starts with "/" (for slash command mode)
  const isSlashMode = content.startsWith('/')
  const slashQuery = isSlashMode ? content.slice(1) : ''
  const filteredCommands = isSlashMode ? filterCommands(slashCommands, slashQuery) : slashCommands

  // Open popover when "/" is typed at start
  useEffect(() => {
    if (isSlashMode && !slashPopoverOpen) {
      setSlashPopoverOpen(true)
    } else if (!isSlashMode && slashPopoverOpen) {
      setSlashPopoverOpen(false)
    }
  }, [isSlashMode, slashPopoverOpen])

  // Handle slash command selection
  const handleSlashSelect = (cmd: SlashCommand) => {
    onChange(`/${cmd.name} `)
    setSlashPopoverOpen(false)
    textareaRef.current?.focus()
  }

  // Handle "/" button click
  const handleSlashButtonClick = () => {
    if (!content.startsWith('/')) {
      onChange('/' + content)
    }
    setSlashPopoverOpen(true)
    textareaRef.current?.focus()
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
    if (e.key === 'Escape' && slashPopoverOpen) {
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
        open={slashPopoverOpen}
        onOpenChange={setSlashPopoverOpen}
        commands={filteredCommands}
        onSelect={handleSlashSelect}
        anchorRef={containerRef}
      />

      {/* Text input */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => onChange(e.target.value)}
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
        {/* Left side - attachment icon and working dir */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleAttachClick}
            disabled={disabled || hasPermission}
            className={cn(
              'text-muted-foreground hover:text-foreground',
              'transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            aria-label="Attach file"
          >
            <Image className="h-5 w-5" />
          </button>

          {(workingDir || onWorkingDirChange) && (
            <FolderPicker
              value={workingDir || ''}
              onChange={onWorkingDirChange}
              disabled={disabled || hasPermission}
              readOnly={!onWorkingDirChange}
            />
          )}
        </div>

        {/* Right side - slash button and submit/stop */}
        <div className="flex items-center gap-2">
          {/* Slash command button */}
          <button
            type="button"
            onClick={handleSlashButtonClick}
            disabled={disabled || hasPermission}
            className={cn(
              'h-9 w-9 rounded-lg',
              'bg-muted hover:bg-muted/80 border border-border',
              'flex items-center justify-center',
              'transition-all',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'text-base font-medium text-muted-foreground',
              slashPopoverOpen && 'bg-accent text-foreground'
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
