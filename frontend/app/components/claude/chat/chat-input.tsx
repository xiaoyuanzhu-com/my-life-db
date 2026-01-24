import { useState, useRef, KeyboardEvent, useEffect } from 'react'
import { ArrowUp, Image } from 'lucide-react'
import { cn } from '~/lib/utils'

interface ChatInputProps {
  onSend: (content: string) => void
  disabled?: boolean
  placeholder?: string
}

export function ChatInput({
  onSend,
  disabled = false,
  placeholder = 'Reply...',
}: ChatInputProps) {
  const [content, setContent] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea as content grows
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
      // Reset height after sending
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault() // Prevent newline from being added
      handleSend()
    }
    // Shift+Enter: allow default behavior (add newline)
  }

  const handleAttachClick = () => {
    // TODO: Implement file attachment
    console.log('Attach file clicked')
  }

  return (
    <div className="bg-background pb-4">
      {/* Container matches message width */}
      <div className="max-w-3xl mx-auto px-6">
        {/* Input card with 2-row layout */}
        <div className="border border-border rounded-xl bg-background px-3 py-2">
          {/* Row 1: Text input */}
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
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

          {/* Row 2: Actions */}
          <div className="flex items-center justify-between mt-2">
            {/* Attachment icon - left */}
            <button
              type="button"
              onClick={handleAttachClick}
              disabled={disabled}
              className={cn(
                'text-muted-foreground hover:text-foreground',
                'transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
              aria-label="Attach file"
            >
              <Image className="h-5 w-5" />
            </button>

            {/* Submit button - right */}
            <button
              type="button"
              onClick={handleSend}
              disabled={disabled || !content.trim()}
              className={cn(
                'h-9 w-9 rounded-lg',
                'bg-primary hover:bg-primary/80',
                'flex items-center justify-center',
                'transition-all',
                'disabled:cursor-not-allowed',
                !content.trim() ? 'opacity-40' : 'opacity-100'
              )}
              aria-label="Send message"
            >
              <ArrowUp className="h-4 w-4 text-primary-foreground" strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
