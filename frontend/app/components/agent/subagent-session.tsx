/**
 * SubagentSession — renders a collapsible sub-session for an Agent tool call.
 * Displays child messages (those with matching parentToolUseId) in a nested container.
 * Recursive: if a child tool call has its own children, renders another SubagentSession.
 */
import { useState } from "react"
import type { ThreadMessageLike } from "@assistant-ui/react"
import type { ToolCallMessagePartStatus } from "@assistant-ui/react"
import type { ReadonlyJSONObject } from "assistant-stream/utils"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible"
import { CheckIcon, ChevronDownIcon, LoaderIcon, XCircleIcon } from "lucide-react"
import { cn } from "~/lib/utils"
import { MarkdownContent } from "~/components/agent/markdown-content"
import { AcpToolRenderer } from "~/components/agent/tool-dispatch"
import { MessageDot } from "./message-dot"

interface SubagentSessionProps {
  toolCallId: string
  toolName: string
  status?: ToolCallMessagePartStatus
  childMessages: ThreadMessageLike[]
  childrenMap: Map<string, ThreadMessageLike[]>
}

/** Count all tool-call parts across child messages */
function countToolCalls(messages: ThreadMessageLike[]): number {
  let count = 0
  for (const msg of messages) {
    if (typeof msg.content === "string") continue
    for (const part of msg.content) {
      if (part.type === "tool-call") count++
    }
  }
  return count
}

/** Status icon for the subagent header */
function StatusIcon({ status }: { status?: ToolCallMessagePartStatus }) {
  if (!status || status.type === "running" || status.type === "requires-action") {
    return <LoaderIcon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
  }
  if (status.type === "complete") {
    return <CheckIcon className="h-3.5 w-3.5 text-green-500" />
  }
  // incomplete/error
  return <XCircleIcon className="h-3.5 w-3.5 text-destructive" />
}

// ── ToolCall content part shape (from ThreadMessageLike) ──────────────
interface ToolCallPart {
  readonly type: "tool-call"
  readonly toolCallId?: string
  readonly toolName: string
  readonly args?: ReadonlyJSONObject
  readonly argsText?: string
  readonly result?: unknown
  readonly isError?: boolean
}

// ── SubagentMessage — renders a single ThreadMessageLike inside a sub-session ──

function SubagentMessage({
  message,
  childrenMap,
}: {
  message: ThreadMessageLike
  childrenMap: Map<string, ThreadMessageLike[]>
}) {
  // String content (simple text message)
  if (typeof message.content === "string") {
    if (message.role === "user") {
      return (
        <div className="py-1">
          <p className="text-xs text-muted-foreground">{message.content}</p>
        </div>
      )
    }
    return (
      <div className="flex items-start gap-1.5 py-1">
        <MessageDot type="assistant" />
        <MarkdownContent text={message.content} className="text-xs" />
      </div>
    )
  }

  // User role — render all text parts as muted
  if (message.role === "user") {
    const textParts = message.content.filter((p) => p.type === "text") as Array<{
      type: "text"
      text: string
    }>
    if (textParts.length === 0) return null
    return (
      <div className="py-1">
        {textParts.map((part, i) => (
          <MarkdownContent
            key={i}
            text={part.text}
            className="text-xs text-muted-foreground"
          />
        ))}
      </div>
    )
  }

  // Assistant role — iterate content parts
  return (
    <div className="space-y-1 py-1">
      {message.content.map((part, i) => {
        if (part.type === "text") {
          const textPart = part as { type: "text"; text: string }
          if (!textPart.text.trim()) return null
          return (
            <div key={i} className="flex items-start gap-1.5">
              <MessageDot type="assistant" />
              <MarkdownContent text={textPart.text} className="text-xs" />
            </div>
          )
        }

        if (part.type === "reasoning") {
          // Skip reasoning blocks for cleanliness
          return null
        }

        if (part.type === "tool-call") {
          const toolPart = part as ToolCallPart
          const toolCallId = toolPart.toolCallId ?? `anon-${i}`
          const children = childrenMap.get(toolCallId)

          if (children && children.length > 0) {
            // Recursive: render another SubagentSession
            return (
              <SubagentSession
                key={toolCallId}
                toolCallId={toolCallId}
                toolName={toolPart.toolName}
                status={
                  toolPart.result !== undefined
                    ? { type: "complete" as const }
                    : { type: "running" as const }
                }
                childMessages={children}
                childrenMap={childrenMap}
              />
            )
          }

          // No children — render with AcpToolRenderer directly
          return (
            <AcpToolRenderer
              key={toolCallId}
              type="tool-call"
              toolCallId={toolCallId}
              toolName={toolPart.toolName}
              args={(toolPart.args ?? {}) as ReadonlyJSONObject}
              argsText={toolPart.argsText ?? JSON.stringify(toolPart.args ?? {})}
              result={toolPart.result}
              isError={toolPart.isError}
              status={
                toolPart.result !== undefined
                  ? { type: "complete" }
                  : { type: "running" }
              }
              addResult={() => {}}
              resume={() => {}}
            />
          )
        }

        // Unknown part type — skip
        return null
      })}
    </div>
  )
}

// ── SubagentSession — main exported component ─────────────────────────

export function SubagentSession({
  toolCallId,
  toolName,
  status,
  childMessages,
  childrenMap,
}: SubagentSessionProps) {
  const isComplete = status?.type === "complete"
  const [open, setOpen] = useState(!isComplete)
  const toolCount = countToolCalls(childMessages)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "rounded-md border border-primary/30 bg-background",
          "ml-2",
        )}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-xs",
              "hover:bg-muted/50 transition-colors rounded-t-md",
              !open && "rounded-b-md",
            )}
          >
            <StatusIcon status={status} />
            <span className="font-medium text-foreground truncate">
              {toolName}
            </span>
            {toolCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                {toolCount}
              </span>
            )}
            <ChevronDownIcon
              className={cn(
                "ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t border-primary/20 px-3 py-2 space-y-1">
            {childMessages.map((msg, i) => (
              <SubagentMessage
                key={msg.id ?? `sub-${toolCallId}-${i}`}
                message={msg}
                childrenMap={childrenMap}
              />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
