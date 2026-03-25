/**
 * UserMessage -- renders a user message bubble in the ACP chat thread.
 *
 * Matches the old Claude Code message-block.tsx user section:
 * - Right-aligned with primary background
 * - Truncation: max 10 lines / 500 chars, gradient fade + "Show more"
 * - Proper max-width
 * - Optimistic messages at 70% opacity
 */
import { useState, useMemo } from "react"
import { MessagePrimitive } from "@assistant-ui/react"
import { useMessage } from "@assistant-ui/react"
import { cn } from "~/lib/utils"
import { MarkdownContent } from "./markdown-content"

const MAX_LINES = 10
const MAX_CHARS = 500

interface UserTextPartProps {
  text: string
}

function UserTextPart({ text }: UserTextPartProps) {
  const [expanded, setExpanded] = useState(false)

  // Check if truncation needed
  const { isTruncated, displayText } = useMemo(() => {
    const lines = text.split("\n")
    const tooManyLines = lines.length > MAX_LINES
    const tooManyChars = text.length > MAX_CHARS

    if (!tooManyLines && !tooManyChars) {
      return { isTruncated: false, displayText: text }
    }

    // Truncate by lines first, then by chars
    let truncated = tooManyLines
      ? lines.slice(0, MAX_LINES).join("\n")
      : text
    if (truncated.length > MAX_CHARS) {
      truncated = truncated.slice(0, MAX_CHARS)
    }
    return { isTruncated: true, displayText: truncated }
  }, [text])

  return (
    <div className="relative">
      <MarkdownContent
        text={expanded ? text : displayText}
        className="text-primary-foreground [&_a]:text-primary-foreground/80 [&_code]:bg-primary-foreground/10 [&_pre]:bg-primary-foreground/10 [&_pre]:border-primary-foreground/20"
      />
      {/* Gradient fade + "Show more" when truncated */}
      {isTruncated && !expanded && (
        <div className="relative">
          <div className="absolute -top-8 left-0 right-0 h-8 bg-gradient-to-b from-transparent to-primary pointer-events-none" />
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-[12px] text-primary-foreground/70 hover:text-primary-foreground transition-colors cursor-pointer mt-1"
          >
            Show more
          </button>
        </div>
      )}
      {isTruncated && expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-[12px] text-primary-foreground/70 hover:text-primary-foreground transition-colors cursor-pointer mt-1"
        >
          Show less
        </button>
      )}
    </div>
  )
}

export function UserMessage() {
  const messageState = useMessage()
  const metadata = messageState.metadata as Record<string, unknown> | undefined
  const custom = metadata?.custom as Record<string, unknown> | undefined
  const isOptimistic = !!custom?.isOptimistic

  return (
    <MessagePrimitive.Root className={cn("flex justify-end mb-4", isOptimistic && "opacity-70")}>
      <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2.5 text-sm break-words">
        <MessagePrimitive.Parts
          components={{
            Text: UserTextPart,
          }}
        />
      </div>
    </MessagePrimitive.Root>
  )
}
