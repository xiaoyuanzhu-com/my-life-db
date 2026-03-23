/**
 * AssistantMessage — renders an assistant message in the ACP chat thread.
 *
 * - Text parts rendered as markdown via MarkdownContent
 * - Reasoning blocks as collapsible <details> with smooth animation
 * - Tool calls routed through AcpToolRenderer (passed via props)
 * - Copy button on hover (copies raw text)
 * - MessageDot for status
 */
import { useState, useCallback } from "react"
import { MessagePrimitive, type ToolCallMessagePartProps } from "@assistant-ui/react"
import { useMessage } from "@assistant-ui/react"
import { Copy, Check } from "lucide-react"
import { MarkdownContent } from "./markdown-content"
import { MessageDot } from "./message-dot"

interface AssistantMessageProps {
  toolsConfig: {
    Override: React.ComponentType<ToolCallMessagePartProps>
  }
}

function AssistantTextPart({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [text])

  return (
    <div className="group/text relative">
      <MarkdownContent text={text} className="text-foreground" />
      {/* Copy button — visible on hover */}
      <button
        type="button"
        onClick={handleCopy}
        className="absolute -top-1 -right-1 opacity-0 group-hover/text:opacity-100 transition-opacity rounded-md p-1 hover:bg-muted text-muted-foreground hover:text-foreground"
        title="Copy text"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  )
}

function AssistantReasoningPart({ text }: { text: string }) {
  return (
    <details className="my-1 group/reasoning">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors select-none">
        Reasoning
      </summary>
      <div className="mt-1 pl-2 border-l border-border overflow-hidden transition-all duration-200">
        <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
          {text}
        </p>
      </div>
    </details>
  )
}

/** Blinking cursor shown when the assistant message is still streaming */
function StreamingCursor() {
  const messageState = useMessage()
  const isRunning = messageState.status?.type === "running"

  if (!isRunning) return null

  return (
    <span
      className="inline-block w-[2px] h-[1em] bg-foreground align-text-bottom ml-0.5"
      style={{ animation: "blink 0.8s step-end infinite" }}
    />
  )
}

export function createAssistantMessage(toolsConfig: AssistantMessageProps["toolsConfig"]) {
  return function AssistantMessage() {
    return (
      <MessagePrimitive.Root className="flex justify-start mb-4 gap-1.5">
        <div className="mt-1 shrink-0">
          <MessageDot type="assistant" />
        </div>
        <div className="max-w-[85%] min-w-0">
          <MessagePrimitive.Parts
            components={{
              Text: AssistantTextPart,
              Reasoning: AssistantReasoningPart,
              tools: toolsConfig,
            }}
          />
          <StreamingCursor />
        </div>
      </MessagePrimitive.Root>
    )
  }
}
