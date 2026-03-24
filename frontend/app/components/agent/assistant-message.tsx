/**
 * AssistantMessage -- renders an assistant message in the ACP chat thread.
 *
 * Matches the old Claude Code message-block.tsx assistant section:
 * - MessageDot + markdown prose content
 * - Copy button (appears on hover, top-right)
 * - Thinking/reasoning blocks: collapsible with "Thinking" label + chevron,
 *   code-block bg when expanded, smooth CSS grid animation
 * - Tool calls routed through AcpToolRenderer (passed via props)
 * - Blinking cursor during streaming
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
        <MarkdownContent text={text} className="text-foreground" />
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

function AssistantReasoningPart({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div>
      {/* Header: "Thinking" label + chevron */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 cursor-pointer text-muted-foreground hover:text-foreground transition-colors select-none"
      >
        <MessageDot type={expanded ? "assistant" : "tool-pending"} />
        <span className="font-mono text-[13px] leading-[1.5] font-semibold text-foreground">
          Thinking
        </span>
        <span className="text-[11px] text-muted-foreground/60">
          {expanded ? "\u25BE" : "\u25B8"}
        </span>
      </button>

      {/* Collapsible thinking content - smooth CSS grid animation */}
      <div className={`collapsible-grid ${expanded ? "" : "collapsed"}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-1 ml-5 p-3 rounded-md overflow-y-auto bg-muted/50"
            style={{ maxHeight: "60vh" }}
          >
            <p className="font-mono text-[13px] leading-[1.5] text-muted-foreground whitespace-pre-wrap break-words">
              {text}
            </p>
          </div>
        </div>
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
                Reasoning: AssistantReasoningPart,
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
