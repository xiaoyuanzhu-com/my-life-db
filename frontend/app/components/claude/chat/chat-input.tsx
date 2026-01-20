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
      e.preventDefault()
      handleSend()
    }
  }

  const handleAttachClick = () => {
    // TODO: Implement file attachment
    console.log('Attach file clicked')
  }

  return (
    <div className="bg-white pb-4">
      {/* Container matches message width */}
      <div className="max-w-3xl mx-auto px-6">
        {/* Input card with 2-row layout */}
        <div className="border border-[#E5E7EB] rounded-xl bg-white px-3 py-2">
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
              'text-[15px] text-[#1A1A1A]',
              'placeholder:text-[#9CA3AF]',
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
                'text-[#4A4A4A] hover:text-[#1A1A1A]',
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
                'bg-[#E5D5C5] hover:bg-[#D5C5B5]',
                'flex items-center justify-center',
                'transition-all',
                'disabled:cursor-not-allowed',
                !content.trim() ? 'opacity-40' : 'opacity-100'
              )}
              aria-label="Send message"
            >
              <ArrowUp className="h-4 w-4 text-[#1A1A1A]" strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
