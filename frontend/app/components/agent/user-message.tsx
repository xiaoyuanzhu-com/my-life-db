/**
 * UserMessage — renders a user message bubble in the ACP chat thread.
 *
 * Right-aligned with primary background. Renders markdown content.
 * Optimistic messages (not yet confirmed by server) show at 70% opacity.
 */
import { MessagePrimitive } from "@assistant-ui/react"
import { useMessage } from "@assistant-ui/react"
import { cn } from "~/lib/utils"
import { MarkdownContent } from "./markdown-content"

interface UserTextPartProps {
  text: string
}

function UserTextPart({ text }: UserTextPartProps) {
  return (
    <MarkdownContent
      text={text}
      className="text-primary-foreground [&_a]:text-primary-foreground/80 [&_code]:bg-primary-foreground/10 [&_pre]:bg-primary-foreground/10 [&_pre]:border-primary-foreground/20"
    />
  )
}

export function UserMessage() {
  const messageState = useMessage()
  const isOptimistic = !!(messageState.metadata as Record<string, unknown>)?.custom &&
    !!((messageState.metadata as { custom?: Record<string, unknown> }).custom?.isOptimistic)

  return (
    <MessagePrimitive.Root className={cn("flex justify-end mb-4", isOptimistic && "opacity-70")}>
      <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2.5 break-words">
        <MessagePrimitive.Parts
          components={{
            Text: UserTextPart,
          }}
        />
      </div>
    </MessagePrimitive.Root>
  )
}
