/**
 * UserMessage — renders a user message bubble in the ACP chat thread.
 *
 * Right-aligned with primary background. Renders markdown content.
 */
import { MessagePrimitive } from "@assistant-ui/react"
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
  return (
    <MessagePrimitive.Root className="flex justify-end mb-4">
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
