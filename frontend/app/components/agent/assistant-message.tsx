/**
 * AssistantMessage -- renders an assistant message in the ACP chat thread.
 *
 * Matches the old Claude Code message-block.tsx assistant section:
 * - MessageDot + markdown prose content
 * - Copy button (appears on hover, top-right)
 * - Reasoning blocks: uses assistant-ui Reasoning + ReasoningGroup components
 * - Tool calls routed through AcpToolRenderer (passed via props)
 * - Blinking cursor during streaming
 */
import { useState, useCallback } from "react"
import { MessagePrimitive, type ToolCallMessagePartProps } from "@assistant-ui/react"
import { useMessage } from "@assistant-ui/react"
import { Copy, Check } from "lucide-react"
import { MarkdownText } from "~/components/assistant-ui/markdown-text"
import { Reasoning, ReasoningGroup } from "~/components/assistant-ui/reasoning"
import { MessageDot } from "./message-dot"

interface AssistantMessageProps {
  toolsConfig: {
    Override: React.ComponentType<ToolCallMessagePartProps>
  }
}

function AssistantTextPart({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text)
    } else {
      // Fallback for non-secure contexts (HTTP)
      const textarea = document.createElement("textarea")
      textarea.value = text
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand("copy")
      document.body.removeChild(textarea)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [text])

  return (
    <div className="group/text relative flex items-start gap-2">
      <MessageDot type="assistant" />
      <div className="flex-1 min-w-0 relative">
        {/* TODO: add HTML iframe preview for lang="html" code blocks (custom markdown component override) */}
        {/* TODO: wire preview-fullscreen.tsx into custom code block handler */}
        {/* TODO: verify dark mode theme switching works with syntax highlighting */}
        <MarkdownText />
        {/* Copy button -- visible on hover, top-right */}
        <button
          type="button"
          onClick={handleCopy}
          className="absolute -top-1 -right-1 opacity-0 group-hover/text:opacity-100 transition-opacity rounded-md p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground"
          title="Copy text"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
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
      <MessagePrimitive.Root className="mb-4">
        <div className="min-w-0">
          <div className="space-y-3">
            <MessagePrimitive.Parts
              components={{
                Text: AssistantTextPart,
                Reasoning: Reasoning,
                ReasoningGroup: ReasoningGroup,
                tools: toolsConfig,
              }}
            />
          </div>
          <StreamingCursor />
        </div>
      </MessagePrimitive.Root>
    )
  }
}
