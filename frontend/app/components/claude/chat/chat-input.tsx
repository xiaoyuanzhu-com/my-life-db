import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { Button } from '~/components/ui/button'
import { Send, Paperclip, AtSign, Slash } from 'lucide-react'
import { cn } from '~/lib/utils'

interface ChatInputProps {
  onSend: (content: string) => void
  disabled?: boolean
  placeholder?: string
}

export function ChatInput({
  onSend,
  disabled = false,
  placeholder = 'Type a message...',
}: ChatInputProps) {
  const [content, setContent] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [content])

  const handleSend = () => {
    const trimmed = content.trim()
    if (trimmed && !disabled) {
      onSend(trimmed)
      setContent('')
      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleAtClick = () => {
    // Insert @ at cursor position
    const textarea = textareaRef.current
    if (textarea) {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const newContent = content.slice(0, start) + '@' + content.slice(end)
      setContent(newContent)
      // Move cursor after @
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 1
        textarea.focus()
      }, 0)
    }
  }

  const handleSlashClick = () => {
    // Insert / at the beginning if empty, or at cursor
    const textarea = textareaRef.current
    if (textarea) {
      if (content === '') {
        setContent('/')
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = 1
          textarea.focus()
        }, 0)
      } else {
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const newContent = content.slice(0, start) + '/' + content.slice(end)
        setContent(newContent)
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 1
          textarea.focus()
        }, 0)
      }
    }
  }

  return (
    <div className="border-t border-border bg-background p-4">
      <div className="flex items-end gap-2">
        {/* Quick action buttons */}
        <div className="flex gap-1 pb-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleAtClick}
            disabled={disabled}
            title="Reference file (@)"
          >
            <AtSign className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleSlashClick}
            disabled={disabled}
            title="Command (/)"
          >
            <Slash className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={disabled}
            title="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
        </div>

        {/* Input area */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={cn(
              'w-full resize-none rounded-lg border border-input bg-background px-3 py-2',
              'text-sm placeholder:text-muted-foreground',
              'focus:outline-none focus:ring-2 focus:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'min-h-[40px] max-h-[200px]'
            )}
          />
        </div>

        {/* Send button */}
        <Button
          type="button"
          size="icon"
          className="h-10 w-10"
          onClick={handleSend}
          disabled={disabled || !content.trim()}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>

      {/* Hints */}
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>Press Enter to send, Shift+Enter for new line</span>
        <span className="hidden sm:inline">@ for files, / for commands</span>
      </div>
    </div>
  )
}
