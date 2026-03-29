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
import { ToolGroup } from "~/components/assistant-ui/tool-group"
import { MessageDot } from "./message-dot"

interface AssistantMessageProps {
  toolsConfig: {
    Override: React.ComponentType<ToolCallMessagePartProps>
  }
}

function AssistantTextPart({ text }: { text: string }) {
  // assistant-ui may inject implicit empty text parts between content groups
  // (e.g., between reasoning and tool-call parts) — skip rendering them
  if (!text.trim()) return null

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

  // Don't show cursor when the last content part is a tool call —
  // the tool's own status indicator (pulsing dot) is sufficient.
  const parts = messageState.content
  if (parts.length > 0 && parts[parts.length - 1].type === "tool-call") {
    return null
  }

  return (
    <span
      className="inline-block w-[2px] h-[1em] bg-foreground align-text-bottom ml-0.5"
      style={{ animation: "blink 0.8s step-end infinite" }}
    />
  )
}

/** Error banner shown when the message ended with an error */
function MessageError() {
  const messageState = useMessage()
  const status = messageState.status
  if (status?.type !== "incomplete" || status.reason !== "error") return null

  const errorText =
    typeof status.error === "string"
      ? status.error
      : status.error
        ? JSON.stringify(status.error)
        : "Unknown error"

  return (
    <div className="mt-2 flex items-start gap-2">
      <MessageDot type="tool-failed" />
      <p className="text-sm text-destructive">{errorText}</p>
    </div>
  )
}

export function createAssistantMessage(toolsConfig: AssistantMessageProps["toolsConfig"]) {
  return function AssistantMessage() {
    return (
      <MessagePrimitive.Root className="mb-4 text-sm">
        <div className="min-w-0">
          <div className="space-y-2">
            <MessagePrimitive.Parts
              components={{
                Text: AssistantTextPart,
                Reasoning: Reasoning,
                ReasoningGroup: ReasoningGroup,
                ToolGroup: ToolGroup,
                tools: toolsConfig,
              }}
            />
          </div>
          <StreamingCursor />
          <MessageError />
        </div>
      </MessagePrimitive.Root>
    )
  }
}
